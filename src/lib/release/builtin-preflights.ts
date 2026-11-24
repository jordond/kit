import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import { runCapture, runQuiet } from '../proc'
import { definePreflight, type Preflight } from './preflight'

/**
 * Built-in iOS preflights: run before any `release.preflight` module, bypassed with
 * `--skip xcconfig` / `--skip swiftpm-linkage`. Each only exists when its paths resolve from config.
 */

export const XCCONFIG_SKIP = 'xcconfig'
export const LINKAGE_SKIP = 'swiftpm-linkage'
export const DEFAULT_LINKAGE_TASK = ':shared:integrateLinkagePackage'
const LINKAGE_DIR_NAME = 'KotlinMultiplatformLinkedPackage'

/** The pbxproj inside `release.ios.project` (an .xcodeproj), or undefined for a workspace. */
export function pbxprojPath(root: string, config: KitConfig): string | undefined {
  const project = config.release?.ios?.project
  if (!project?.endsWith('.xcodeproj')) return undefined
  return join(root, project, 'project.pbxproj')
}

export interface XcconfigClash {
  key: string
  file: string
}

/** Keys set in both the pbxproj and an xcconfig in `dir`. The pbxproj silently wins. */
export function xcconfigClashes(dir: string, pbxproj: string): XcconfigClash[] {
  const text = readFileSync(pbxproj, 'utf8')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.xcconfig'))
    .flatMap((file) =>
      [...readFileSync(join(dir, file), 'utf8').matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)]
        .map((m) => m[1]!)
        .filter((key) => new RegExp(`^\\s*"?${key}(\\[[^\\]]*\\])?"?\\s*=`, 'm').test(text))
        .map((key) => ({ key, file })),
    )
}

/** True when the config names an xcconfig and the project's pbxproj exists on disk. */
export function xcconfigApplies(root: string, config: KitConfig): boolean {
  const xc = config.release?.ios?.xcconfig
  const pbx = pbxprojPath(root, config)
  return !!xc && !!pbx && existsSync(pbx) && existsSync(join(root, dirname(xc)))
}

/**
 * A build setting in the pbxproj beats the same key in any xcconfig, and Xcode writes there on its
 * own. A key set in both ships the pbxproj value while the xcconfig goes on describing one nobody
 * builds. Returns the problem, or undefined when clean or not applicable.
 */
export function checkXcconfigOwnership(root: string, config: KitConfig): string | undefined {
  if (!xcconfigApplies(root, config)) return undefined
  const clashes = xcconfigClashes(
    join(root, dirname(config.release!.ios!.xcconfig!)),
    pbxprojPath(root, config)!,
  )
  if (!clashes.length) return undefined
  const rel = join(config.release!.ios!.project, 'project.pbxproj')
  return `${rel} also sets ${clashes.map((c) => `${c.key} (${c.file})`).join(', ')}, which overrides the xcconfig. Delete it from the pbxproj and edit the xcconfig instead.`
}

export function xcconfigPreflight(): Preflight {
  return definePreflight({
    title: 'no xcconfig key is overridden by the pbxproj',
    skipFlag: XCCONFIG_SKIP,
    platforms: ['ios'],
    check(ctx) {
      const problem = checkXcconfigOwnership(ctx.root, ctx.config)
      if (problem) throw new KitError(problem, undefined, ExitCode.precondition)
    },
  })
}

export interface LinkageDeps {
  gradle?: (task: string) => Promise<number>
  resolve?: () => Promise<unknown>
  porcelain?: (path: string) => Promise<string>
}

export interface LinkageSetup {
  /** Absolute linkage package dir. */
  dir: string
  task: string
}

/**
 * The linkage check applies when `release.ios.swiftpmLinkage` is not false, `gradle.root` is set and
 * the linkage package dir exists beside the iOS project (`swiftpmLinkage.dir` overrides).
 */
export function linkageSetup(root: string, config: KitConfig): LinkageSetup | undefined {
  const ios = config.release?.ios
  const opt = ios?.swiftpmLinkage
  if (opt === false || !config.gradle || !ios) return undefined
  const o = typeof opt === 'object' ? opt : {}
  const dir = join(root, o.dir ?? join(dirname(ios.project), LINKAGE_DIR_NAME))
  if (!existsSync(dir)) return undefined
  return { dir, task: o.task ?? DEFAULT_LINKAGE_TASK }
}

/**
 * Subpackages are named for the version they wrap and the generator only adds, so every bump leaves
 * a dead directory. The manifest lists the live ones.
 */
export function pruneStaleSubpackages(dir: string): string[] {
  const subpackages = join(dir, 'subpackages')
  const manifestPath = join(dir, 'Package.swift')
  if (!existsSync(subpackages) || !existsSync(manifestPath)) return []
  const manifest = readFileSync(manifestPath, 'utf8')
  // The closing quote matters: without it `…_0_5_1` would keep `…_0_5_10` alive.
  const stale = readdirSync(subpackages).filter((name) => !manifest.includes(`subpackages/${name}"`))
  for (const name of stale) rmSync(join(subpackages, name), { recursive: true, force: true })
  return stale
}

/**
 * The `Compile Kotlin Framework` phase regenerates the linkage package from the Gradle SwiftPM
 * metadata and aborts the archive when it differs from what it recorded; that happens minutes in.
 * `integrateLinkagePackage` is the same regeneration without Xcode's environment (XCODEPROJ_PATH
 * stands in for it). Only locally: the fingerprint lives under build/, so CI never sees the abort.
 * Returns the problem, or undefined when current or not applicable.
 */
export async function checkSwiftPMLinkage(
  root: string,
  config: KitConfig,
  deps: LinkageDeps = {},
): Promise<string | undefined> {
  const setup = linkageSetup(root, config)
  if (!setup) return undefined
  const gradleRoot = join(root, config.gradle!.root)
  const project = resolve(root, config.release!.ios!.project)
  const gradle =
    deps.gradle ??
    (async (task) =>
      (await runQuiet(['./gradlew', '-q', task], { cwd: gradleRoot, env: { XCODEPROJ_PATH: project } })).code)
  const porcelain =
    deps.porcelain ??
    (async (path) => (await runCapture(['git', 'status', '--porcelain', '--', path], { cwd: root })).stdout)
  const reresolve =
    deps.resolve ??
    (() => runQuiet(['xcodebuild', '-resolvePackageDependencies', '-project', project], { cwd: root }))

  if ((await gradle(setup.task)) !== 0) {
    return `\`${setup.task}\` failed: the SwiftPM linkage package cannot be regenerated, so the archive would fail too. Re-run it in ${config.gradle!.root} to see why.`
  }
  pruneStaleSubpackages(setup.dir)
  const changed = (await porcelain(setup.dir)).trim()
  if (!changed) return undefined
  // Xcode resolved its graph against the path that just changed and would abort again however clean
  // the tree gets, so re-resolve rather than leave it as a step to remember after committing.
  await reresolve()
  return `the committed SwiftPM linkage package is not what \`${setup.task}\` generates: the archive regenerates it mid-build and aborts. The Xcode package graph was re-resolved; review the diff, commit it, then release again:\n${changed}`
}

export function swiftpmLinkagePreflight(deps: LinkageDeps = {}): Preflight {
  return definePreflight({
    title: 'the committed SwiftPM linkage package is current',
    skipFlag: LINKAGE_SKIP,
    platforms: ['ios'],
    async check(ctx) {
      const problem = await checkSwiftPMLinkage(ctx.root, ctx.config, deps)
      if (problem) throw new KitError(problem, undefined, ExitCode.precondition)
    },
  })
}

/** Built-ins that apply to this config, in run order. */
export function builtinPreflights(root: string, config: KitConfig): Preflight[] {
  const out: Preflight[] = []
  if (xcconfigApplies(root, config)) out.push(xcconfigPreflight())
  if (linkageSetup(root, config)) out.push(swiftpmLinkagePreflight())
  return out
}
