import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import pc from 'picocolors'
import type { Flags, KitContext } from '../../cli/command'
import type { KitConfig, Track } from '../../config/schema'
import { interrupted, onCleanup } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { appFastlaneDir, runLane } from '../fastlane'
import { currentBranch, dirtyFiles, push, tag } from '../git'
import { emitJson, withStdoutOnStderr } from '../log'
import { ProcError, runLines } from '../proc'
import { confirm, text } from '../prompt'
import { secretFile } from '../secrets'
import { commandStep, runSteps, type Step, type StepResult, stepTimings, summarize } from '../steps'
import {
  aabFromOutput,
  findAab,
  keystoreProperties,
  moduleName,
  moduleYamlPath,
  releaseModuleYaml,
  requireWrapper,
  WRAPPER,
} from '../toolchain'
import { appleCreds, keystoreCreds, onGitHubActions, playCreds } from './creds'
import { clampNotes, mobileTag, PLAY_NOTES_MAX, releaseNotes } from './notes'
import { loadPreflights } from './preflight'
import { androidVersionDrift, iosVersionDrift, readVersion } from './version'

/**
 * `kit release ios|android --track …` (PLAN §9.3):
 *   preconditions → preflight + resolve (tree) → confirm → build + upload + post (tree) → tag → summary.
 * The working tree is never modified: version and build reach the build as lane inputs. The one
 * exception is a Kotlin toolchain Android build, which has no build properties: the app module's
 * module.yaml gets versionName, versionCode and signing for the build and is restored after.
 */

export type Platform = 'ios' | 'android'

export interface MobileOptions {
  platform: Platform
  track: Track
  build?: number
  notes?: string
  /** Android prod staged-rollout fraction. */
  rollout?: number
  /** Android: upload as a draft release. */
  draft?: boolean
  /** `--skip` values: preflight skipFlags. */
  skip: string[]
}

export interface MobileResult {
  platform: Platform
  track: Track
  version: string
  build: number
  notes: string
  dryRun: boolean
  artifacts: Record<string, string>
  uploaded: boolean
  tag?: string
  tagPushed?: boolean
}

const APP_STORE_WHATS_NEW_MAX = 4000
export const DEFAULT_BRANCHES = ['main', 'release/*']

/** Branch allowed by `release.branches` (globs). In CI a detached HEAD falls back to GITHUB_REF_NAME. */
export async function checkBranch(root: string, config: KitConfig): Promise<string> {
  let branch = await currentBranch(root)
  if (branch === 'HEAD' && process.env.GITHUB_REF_NAME) branch = process.env.GITHUB_REF_NAME
  const allowed = config.release?.branches ?? DEFAULT_BRANCHES
  if (!allowed.some((g) => new Bun.Glob(g).match(branch))) {
    throw new KitError(
      `Releases run from ${allowed.join(', ')}; you are on "${branch}"`,
      'Switch branch, or add it to release.branches in kit.config.ts',
      ExitCode.precondition,
    )
  }
  return branch
}

export async function checkClean(root: string): Promise<void> {
  const dirty = await dirtyFiles(root)
  if (dirty.length) {
    throw new KitError(
      `Working tree is not clean:\n${dirty
        .slice(0, 20)
        .map((l) => `    ${l}`)
        .join('\n')}`,
      'Commit or stash first',
      ExitCode.precondition,
    )
  }
}

/**
 * §9.3 step 1 (doctor --release): fail before secrets are decoded or the store is queried.
 * `toolchain`: the Kotlin toolchain wrapper provisions its own JDK, so java isn't needed.
 */
export function checkTools(
  platform: Platform,
  which: (bin: string) => string | null = Bun.which,
  toolchain = false,
): void {
  const need = ['bundle', ...(platform === 'ios' ? ['xcodebuild'] : []), ...(toolchain ? [] : ['java'])]
  const missing = need.filter((b) => !which(b))
  if (missing.length) {
    throw new KitError(
      `Missing tools for an ${platform} release: ${missing.join(', ')}`,
      'Run `kit doctor` (Ruby + Bundler, a JDK, and Xcode for iOS)',
      ExitCode.precondition,
    )
  }
}

const abs = (root: string, p: string) => (isAbsolute(p) ? p : resolve(root, p))

/** KIT_OUTPUT_DIR keeps the artifacts; otherwise they go in a temp dir removed on exit (§9.3). */
function outputDir(): string {
  if (process.env.KIT_OUTPUT_DIR) {
    mkdirSync(process.env.KIT_OUTPUT_DIR, { recursive: true })
    return process.env.KIT_OUTPUT_DIR
  }
  const dir = mkdtempSync(join(tmpdir(), 'kit-release-'))
  onCleanup(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Config-derived lane inputs (bundle ids, team, package, Gradle root): shared with `kit fastlane`. */
export function laneConfigEnv(root: string, config: KitConfig): Record<string, string> {
  const ios = config.release?.ios
  const android = config.release?.android
  return {
    ...(ios
      ? {
          KIT_IOS_BUNDLE_IDS: ios.bundleIds.join(','),
          KIT_IOS_BUNDLE_ID: ios.bundleIds[0]!,
          KIT_IOS_PROJECT: abs(root, ios.project),
          KIT_IOS_SCHEME: ios.scheme,
          ...(ios.teamId ? { KIT_IOS_TEAM_ID: ios.teamId } : {}),
        }
      : {}),
    ...(android ? { KIT_ANDROID_PACKAGE: android.packageName, KIT_ANDROID_MODULE: android.module } : {}),
    ...(config.gradle ? { KIT_GRADLE_ROOT: abs(root, config.gradle.root) } : {}),
  }
}

/** A step that runs one lane; a non-zero exit fails it with the lane's output. */
export function laneStep(
  title: string,
  appRoot: string,
  platform: Platform,
  lane: string,
  env: () => Record<string, string>,
  onOutputs: (o: Record<string, string>) => void = () => {},
): Step {
  return {
    title,
    task: async (update) => {
      const r = await runLane(appRoot, platform, lane, { env: env(), onLine: update })
      if (r.code !== 0) {
        const { ProcError } = await import('../proc')
        throw new ProcError(['fastlane', platform, lane], r.code, r.output)
      }
      onOutputs(r.outputs)
    },
  }
}

function failed(results: StepResult[]): boolean {
  return results.some((r) => !r.ok)
}

/** Ask per §9.1. Returns false when the user declines. */
export async function confirmTrack(flags: Flags, track: Track, summary: string): Promise<boolean> {
  if (flags.dryRun || track === 'internal') return true
  if (track !== 'prod') return confirm(flags, `Release ${summary}?`)
  // prod: GitHub Actions runs it in the `production` environment, which needs reviewer approval (§9.6).
  // Only GITHUB_ACTIONS counts: CI=true can come from a shell or the root .env.
  if (onGitHubActions()) return true
  const typed = await text({ ...flags, yes: false }, `Type "prod" to release ${summary} to production`, {
    hint: 'Production releases need a terminal (or CI with the production environment)',
  })
  return typed.trim() === 'prod'
}

export async function releaseMobile(
  ctx: Pick<KitContext, 'root' | 'config' | 'flags' | 'log'>,
  opts: MobileOptions,
): Promise<void> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const { root, config } = ctx as { root: string; config: KitConfig }
  const { platform, track } = opts
  const flags = ctx.flags
  const ios = config.release?.ios
  const android = config.release?.android
  if (platform === 'ios' && !ios) {
    throw new KitError('No release.ios in kit.config.ts', undefined, ExitCode.config)
  }
  if (platform === 'android' && !android) {
    throw new KitError('No release.android in kit.config.ts', undefined, ExitCode.config)
  }
  if (platform === 'android' && !config.gradle && !config.toolchain) {
    throw new KitError(
      'Android releases need gradle.root or toolchain.root in kit.config.ts',
      undefined,
      ExitCode.config,
    )
  }
  const toolchain = !!config.toolchain
  if (platform === 'ios' && process.platform !== 'darwin') {
    throw new KitError('iOS releases need macOS (xcodebuild)', undefined, ExitCode.precondition)
  }

  // ---- preconditions
  let notes = opts.notes?.trim()
  if (platform === 'ios' && track === 'prod' && !flags.dryRun) {
    if (!notes) {
      throw new KitError(
        '--track prod needs --notes "<What\'s New>"',
        'App Store Connect rejects an update without it, and users read it',
        ExitCode.usage,
      )
    }
    if (notes.length > APP_STORE_WHATS_NEW_MAX) {
      throw new KitError(`--notes is ${notes.length} chars; the App Store allows ${APP_STORE_WHATS_NEW_MAX}`)
    }
  }
  const rollout = opts.rollout ?? android?.prodRollout ?? 0.1
  if (!(rollout > 0 && rollout <= 1)) {
    throw new KitError(`--rollout must be in (0, 1], got ${rollout}`, undefined, ExitCode.usage)
  }
  if (opts.build !== undefined && !(Number.isInteger(opts.build) && opts.build > 0)) {
    throw new KitError(`--build must be a positive integer, got ${opts.build}`, undefined, ExitCode.usage)
  }
  checkTools(platform, Bun.which, toolchain)
  if (platform === 'android' && toolchain) requireWrapper(root, config)
  await checkClean(root)
  const branch = await checkBranch(root, config)
  const version = readVersion(root, config, platform)
  if (platform === 'ios') {
    const drift = iosVersionDrift(root, config)
    if (drift) {
      throw new KitError(
        `iOS version drift: ${config.versions!.file} says ${drift.toml}, ${drift.file} says ${drift.xcconfig ?? '(no MARKETING_VERSION)'}`,
        'Set MARKETING_VERSION to the TOML version and commit (`kit version bump` keeps them together)',
        ExitCode.precondition,
      )
    }
  }
  if (platform === 'android' && toolchain) {
    const drift = androidVersionDrift(root, config)
    if (drift) {
      throw new KitError(
        `Android version drift: ${config.versions!.file} says ${drift.toml}, ${drift.file} says ${drift.module}`,
        'Set versionName to the TOML version and commit (`kit version bump` keeps them together)',
        ExitCode.precondition,
      )
    }
  }
  const appRoot = appFastlaneDir(root, config)

  // ---- secrets (before any lane: next_build needs the ASC key)
  const secrets: Record<string, string> =
    platform === 'ios'
      ? appleCreds({ match: true, ci: onGitHubActions() }).env
      : { ...playCreds(), ...keystoreCreds() }

  const common: Record<string, string> = { ...secrets, ...laneConfigEnv(root, config) }

  // ---- preflight + resolve
  const preflights = (await loadPreflights(root, config)).filter(
    (p) => !p.platforms || p.platforms.includes(platform),
  )
  const pre: Step[] = []
  for (const p of preflights) {
    if (p.skipFlag && opts.skip.includes(p.skipFlag)) {
      ctx.log.warn(`skipped preflight: ${p.title} (--skip ${p.skipFlag})`)
      continue
    }
    pre.push({
      title: p.title,
      task: () => p.check({ root, config, flags, log: ctx.log }, { platform, track, version }),
    })
  }
  if (platform === 'android') {
    for (const g of android!.gates ?? []) {
      if (!g.tracks.includes(track)) continue
      pre.push(
        toolchain
          ? commandStep(`gate kotlin ${g.task}`, [WRAPPER, ...g.task.split(/\s+/).filter(Boolean)], {
              cwd: abs(root, config.toolchain!.root),
            })
          : commandStep(`gate ${g.task}`, ['./gradlew', g.task], { cwd: abs(root, config.gradle!.root) }),
      )
    }
  }
  let build = opts.build
  if (build === undefined) {
    const lane = platform === 'ios' ? 'next_build' : 'next_code'
    pre.push(
      laneStep(
        `next ${platform === 'ios' ? 'build number' : 'version code'}`,
        appRoot,
        platform,
        lane,
        () => common,
        (o) => {
          const n = Number(o[platform === 'ios' ? 'NEXT_BUILD' : 'NEXT_CODE'])
          if (!Number.isInteger(n) || n <= 0)
            throw new KitError(`fastlane ${platform} ${lane} reported no number`)
          build = n
        },
      ),
    )
  }
  if (pre.length) {
    const results = await withStdoutOnStderr(() =>
      runSteps([{ title: 'preflight', steps: pre }], flags, { bail: true }),
    )
    if (failed(results)) {
      const code = summarize('preflight', results, started, `Pass --build/--code to skip the store lookup`)
      if (flags.json) emitJson({ platform, track, ok: false, stage: 'preflight', results, ms: elapsed() })
      process.exitCode = code === 130 ? 130 : ExitCode.precondition
      return
    }
  }
  if (build === undefined) throw new KitError('No build number resolved')

  if (!notes) {
    const r = await releaseNotes(platform, root)
    notes = r.notes || `${platform} ${version} (${build})`
  }
  if (platform === 'android') notes = clampNotes(notes, config.release?.notes?.maxLength ?? PLAY_NOTES_MAX)

  // ---- confirm
  const where =
    platform === 'ios'
      ? track === 'prod'
        ? 'App Store (phased, manual release)'
        : track === 'internal'
          ? 'TestFlight internal'
          : `TestFlight group "${ios!.testflightGroups?.[track] ?? track}"`
      : `Play ${track === 'prod' ? 'production' : track}${track === 'prod' ? ` (rollout ${rollout})` : ''}${opts.draft ? ' as draft' : ''}`
  const summary = `${config.name} ${platform} ${version} (${build}) → ${where}`
  if (!flags.json) {
    process.stderr.write(
      `\n${pc.bold(summary)}${flags.dryRun ? pc.yellow('  [dry run: build only, no upload]') : ''}\n${pc.dim(`branch ${branch}`)}\n${pc.dim(notes.replace(/^/gm, '  '))}\n\n`,
    )
  }
  if (!(await confirmTrack(flags, track, summary))) {
    throw new KitError('Release cancelled', undefined, ExitCode.interrupted)
  }

  // ---- build + upload + post
  const out = outputDir()
  const artifacts: Record<string, string> = {}
  const steps: Step[] = []
  /** After the tag: a failure here warns but doesn't fail a release the store already has. */
  const post: Step[] = []
  // kit.release bakes BuildConstants.IS_INTERNAL from KIT_INTERNAL (Gradle and the Xcode script phase
  // inherit it). A build promoted from internal to a later track keeps it. Always explicit: the lane
  // inherits the shell and the root `.env`, and a stray KIT_INTERNAL=1 there must not mark a prod build.
  const internalFlag: Record<string, string> = { KIT_INTERNAL: track === 'internal' ? '1' : '0' }
  if (platform === 'ios') {
    steps.push(
      laneStep(
        'build',
        appRoot,
        'ios',
        'build',
        () => ({
          ...common,
          KIT_IOS_PROJECT: abs(root, ios!.project),
          KIT_IOS_SCHEME: ios!.scheme,
          KIT_IOS_VERSION: version,
          KIT_IOS_BUILD: String(build),
          ...internalFlag,
          KIT_IOS_OUTPUT: join(out, ios!.output),
        }),
        (o) => {
          if (o.ARTIFACT_IPA) artifacts.ipa = o.ARTIFACT_IPA
          if (o.ARTIFACT_DSYM) artifacts.dsym = o.ARTIFACT_DSYM
        },
      ),
    )
    if (!flags.dryRun) {
      const groups = track === 'alpha' || track === 'beta' ? (ios!.testflightGroups?.[track] ?? track) : ''
      steps.push(
        laneStep(
          track === 'prod' ? 'upload App Store' : 'upload TestFlight',
          appRoot,
          'ios',
          track === 'prod' ? 'upload_appstore' : 'upload_testflight',
          () => ({
            ...common,
            KIT_IOS_IPA: required(artifacts.ipa, 'ipa'),
            KIT_TESTFLIGHT_GROUPS: groups,
            KIT_RELEASE_NOTES: notes!,
          }),
        ),
      )
      if (ios!.sentry) {
        post.push(
          laneStep('upload dSYMs', appRoot, 'ios', 'upload_symbols', () => ({
            ...common,
            KIT_IOS_DSYM: required(artifacts.dsym, 'dSYM'),
            KIT_SENTRY_ORG: ios!.sentry!.org,
            KIT_SENTRY_PROJECT: ios!.sentry!.project,
          })),
        )
      }
    }
  } else {
    // Gradle writes into the module's build outputs; KIT_OUTPUT_DIR gets a copy (CI uploads it).
    const keep = (p: string) => {
      if (!process.env.KIT_OUTPUT_DIR) return p
      const dest = join(out, basename(p))
      copyFileSync(p, dest)
      return dest
    }
    if (toolchain) {
      steps.push(
        toolchainBuildStep(root, config, {
          version,
          code: build,
          keystore: common.KIT_ANDROID_KEYSTORE_FILE!,
          env: internalFlag,
          onArtifact: (aab) => {
            artifacts.aab = keep(aab)
          },
        }),
      )
    } else {
      steps.push(
        laneStep(
          'build',
          appRoot,
          'android',
          'build',
          () => ({
            ...common,
            KIT_ANDROID_VERSION: version,
            KIT_ANDROID_CODE: String(build),
            ...internalFlag,
          }),
          (o) => {
            if (o.ARTIFACT_AAB) artifacts.aab = keep(o.ARTIFACT_AAB)
            if (o.ARTIFACT_APK) artifacts.apk = keep(o.ARTIFACT_APK)
          },
        ),
      )
    }
    if (!flags.dryRun) {
      steps.push(
        laneStep(`upload Play ${track}`, appRoot, 'android', 'upload_play', () => ({
          ...common,
          KIT_ANDROID_AAB: required(artifacts.aab, 'aab'),
          KIT_ANDROID_CODE: String(build),
          KIT_PLAY_TRACK: track,
          ...(track === 'prod' ? { KIT_PLAY_ROLLOUT: String(rollout) } : {}),
          // Explicit either way, so an inherited value never decides it.
          KIT_PLAY_DRAFT: opts.draft ? '1' : '0',
          KIT_RELEASE_NOTES: notes!,
        })),
      )
    }
  }
  const results = await runSteps([{ title: `${platform} ${track}`, steps }], flags, { bail: true })
  const result: MobileResult = {
    platform,
    track,
    version,
    build,
    notes,
    dryRun: flags.dryRun,
    artifacts,
    uploaded: false,
  }
  // Steps skipped by an interrupt record no result, so count them too.
  if (failed(results) || results.length !== steps.length || interrupted()) {
    if (flags.json) emitJson({ ...result, ok: false, results, ms: elapsed() })
    process.exitCode = summarize(`release ${platform}`, results, started)
    return
  }
  result.uploaded = !flags.dryRun

  // ---- tag (only after a successful upload; never forced)
  if (!flags.dryRun) {
    const name = mobileTag(platform, version, build)
    result.tag = name
    try {
      await tag(name, { cwd: root, message: `${platform} ${version} (${build}) → ${track}` })
      await push([`refs/tags/${name}`], { cwd: root })
      result.tagPushed = true
    } catch (e) {
      result.tagPushed = false
      const msg = `uploaded, but tagging ${name} failed: ${e instanceof Error ? e.message : String(e)}`
      ctx.log.warn(msg)
      if (onGitHubActions())
        process.stderr.write(`::warning title=kit release::${msg.replace(/\r?\n/g, ' ')}\n`)
      ctx.log.dim(`  › git tag -a ${name} -m "${platform} ${version} (${build})" && git push origin ${name}`)
    }
  }

  let postResults: StepResult[] = []
  if (post.length) {
    postResults = await runSteps([{ title: 'post', steps: post }], flags)
    for (const p of postResults.filter((x) => !x.ok)) {
      ctx.log.warn(`${p.title} failed after the upload (the release stands): ${p.error ?? ''}`)
    }
  }

  if (flags.json)
    emitJson({
      ...result,
      ok: true,
      post: postResults.map((p) => ({ title: p.title, ok: p.ok, ms: Math.round(p.ms) })),
      steps: stepTimings(results),
      ms: elapsed(),
    })
  summarize(`release ${platform}`, results, started)
  if (!flags.json) {
    for (const [k, v] of Object.entries(artifacts)) ctx.log.dim(`  ${k}: ${v}`)
    if (!process.env.KIT_OUTPUT_DIR && Object.keys(artifacts).length) {
      ctx.log.dim('  (temp artifacts are removed on exit; set KIT_OUTPUT_DIR to keep them)')
    }
    if (result.tag) ctx.log.dim(`  tag: ${result.tag}${result.tagPushed ? '' : ' (not pushed)'}`)
  }
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new KitError(`The build lane reported no ${what}`)
  return value
}

/**
 * `./kotlin package -m <module>` with the release values written into the module's module.yaml:
 * versionName, versionCode, and signing pointing at a keystore.properties in kit's 0600 temp dir.
 * The file is restored after the build, on failure, and on Ctrl-C.
 */
export function toolchainBuildStep(
  root: string,
  config: KitConfig,
  opts: {
    version: string
    code: number
    /** Decoded upload keystore (KIT_ANDROID_KEYSTORE_FILE). */
    keystore: string
    env?: Record<string, string>
    onArtifact: (aab: string) => void
  },
): Step {
  const module = config.release!.android!.module
  return {
    title: `build (kotlin package -m ${moduleName(module)})`,
    task: async (update) => {
      const dir = requireWrapper(root, config)
      const rel = moduleYamlPath(config, module)
      const path = join(root, rel)
      const before = readFileSync(path, 'utf8')
      const props = secretFile(
        'keystore.properties',
        keystoreProperties(
          opts.keystore,
          process.env.ANDROID_KEYSTORE_ALIAS!.trim(),
          process.env.ANDROID_KEYSTORE_PASSWORD!,
        ),
      )
      const after = releaseModuleYaml(
        before,
        { version: opts.version, code: opts.code, signingProperties: props },
        rel,
      )
      const restore = () => writeFileSync(path, before)
      const off = onCleanup(restore)
      writeFileSync(path, after)
      try {
        const cmd = [WRAPPER, 'package', '-m', moduleName(module)]
        const { code, output } = await runLines(cmd, { cwd: dir, env: opts.env, onLine: update })
        if (code !== 0) throw new ProcError(cmd, code, output)
        const aab = aabFromOutput(output, dir) ?? findAab(dir, module)
        if (!aab) {
          throw new KitError(
            `kotlin package -m ${moduleName(module)} reported no .aab`,
            `Look under ${join(config.toolchain!.root, 'build/tasks')}; the toolchain's output layout may have changed`,
          )
        }
        opts.onArtifact(aab)
      } finally {
        restore()
        off()
      }
    },
  }
}
