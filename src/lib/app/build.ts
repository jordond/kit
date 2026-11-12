import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { KitConfig } from '../../config/schema'
import type { DeviceEnv, Platform } from '../devices'
import { ExitCode, KitError } from '../errors'
import { runToStderr } from '../proc'
import { moduleName, requireWrapper, WRAPPER } from '../toolchain'
import { androidApp, iosApp } from './config'

/**
 * Build the debug app (ported from brewd `lib/client-app.ts`): Gradle or the Kotlin toolchain for
 * Android, xcodebuild or the toolchain for iOS. `buildPlan` is pure so `--dry-run` and tests need no
 * spawn; `buildApp` runs it and finds what it produced.
 */

export interface BuildOptions {
  /** Release variant instead of debug. */
  release?: boolean
  /** Simulator UDID the iOS build targets; absent means any simulator. */
  device?: string
}

export interface BuildPlan {
  platform: Platform
  /** Argv, `cmd[0]` first. */
  cmd: string[]
  cwd: string
  /** Where the artifact lands, absolute. */
  artifactDir: string
  /** `.apk` or `.app`. */
  ext: '.apk' | '.app'
}

const gradleRoot = (root: string, config: KitConfig): string => resolve(root, config.gradle?.root ?? '.')

export function buildPlan(
  root: string,
  config: KitConfig,
  platform: Platform,
  opts: BuildOptions = {},
): BuildPlan {
  const variant = opts.release ? 'Release' : 'Debug'
  if (platform === 'android') {
    const app = androidApp(config)
    if (config.gradle) {
      const cwd = gradleRoot(root, config)
      const dir = moduleName(app.module)
      return {
        platform,
        cmd: [
          existsSync(join(cwd, 'gradlew')) ? './gradlew' : 'gradle',
          `:${dir.replaceAll('/', ':')}:assemble${variant}`,
        ],
        cwd,
        artifactDir: join(cwd, dir, 'build', 'outputs', 'apk', variant.toLowerCase()),
        ext: '.apk',
      }
    }
    if (config.toolchain) {
      const cwd = resolve(root, config.toolchain.root)
      const module = moduleName(app.module)
      return {
        platform,
        cmd: [WRAPPER, 'build', '-m', module, '-p', 'android', '-v', variant.toLowerCase()],
        cwd,
        artifactDir: join(cwd, 'build', 'tasks', `_${module}_buildAndroid${variant}`),
        ext: '.apk',
      }
    }
    throw new KitError(
      'kit.config.ts sets neither gradle nor toolchain',
      'Set gradle.root or toolchain.root: kit builds Android with one of them',
      ExitCode.config,
    )
  }

  const app = iosApp(config)
  if (config.toolchain) {
    const cwd = resolve(root, config.toolchain.root)
    return {
      platform,
      cmd: [WRAPPER, 'build', '-m', app.module, '-p', 'iosSimulatorArm64', '-v', variant.toLowerCase()],
      cwd,
      artifactDir: join(
        cwd,
        'build',
        'tasks',
        `_${app.module}_buildIosAppIosSimulatorArm64${variant}`,
        'bin',
        `${variant}-iphonesimulator`,
      ),
      ext: '.app',
    }
  }
  const derived = resolve(root, dirname(app.project), 'build', 'kit')
  return {
    platform,
    cmd: [
      'xcodebuild',
      app.project.endsWith('.xcworkspace') ? '-workspace' : '-project',
      app.project,
      '-scheme',
      app.scheme,
      '-configuration',
      variant,
      '-destination',
      opts.device ? `platform=iOS Simulator,id=${opts.device}` : 'generic/platform=iOS Simulator',
      '-derivedDataPath',
      derived,
      'build',
    ],
    cwd: root,
    artifactDir: join(derived, 'Build', 'Products', `${variant}-iphonesimulator`),
    ext: '.app',
  }
}

/** The newest entry of `dir` ending in `ext` (`.app` is a directory, `.apk` a file), or undefined. */
export function findArtifact(dir: string, ext: string): string | undefined {
  if (!existsSync(dir)) return undefined
  const found = readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return found[0]?.path
}

/** Run a child with its stdout on stderr (stdout is for results); non-zero is a failed command. */
export async function runChecked(cmd: readonly string[], cwd?: string): Promise<void> {
  let code: number
  try {
    code = await runToStderr(cmd, { cwd })
  } catch {
    throw new KitError(`${cmd[0]} not found`, `Install ${cmd[0]} and put it on PATH`, ExitCode.precondition)
  }
  if (code !== 0) throw new KitError(`${cmd.slice(0, 3).join(' ')} failed (exit ${code})`)
}

export function requireMac(what: string): void {
  if (process.platform !== 'darwin') {
    throw new KitError(`${what} needs macOS (Xcode)`, undefined, ExitCode.precondition)
  }
}

export interface BuildResult {
  artifact: string
  cmd: string[]
  cwd: string
}

export async function buildApp(
  env: Pick<DeviceEnv, 'root' | 'config' | 'log'>,
  platform: Platform,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const plan = buildPlan(env.root, env.config, platform, opts)
  if (platform === 'ios') requireMac('Building the iOS app')
  if (env.config.toolchain && !env.config.gradle) requireWrapper(env.root, env.config)
  env.log.step(plan.cmd.join(' '))
  await runChecked(plan.cmd, plan.cwd)
  const artifact = findArtifact(plan.artifactDir, plan.ext)
  if (artifact === undefined) {
    throw new KitError(
      `The build succeeded but left no ${plan.ext} in ${plan.artifactDir}`,
      'Check the build output above; kit looks for the newest artifact in that directory',
    )
  }
  return { artifact, cmd: plan.cmd, cwd: plan.cwd }
}
