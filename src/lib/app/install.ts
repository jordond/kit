import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { onCleanup } from '../cleanup'
import {
  adb,
  type DeviceEnv,
  type DeviceTarget,
  listDevices,
  listSimulators,
  platformOf,
  quietCapture,
  resolveDevice,
} from '../devices'
import { ExitCode, KitError } from '../errors'
import { buildApp, buildPlan, findArtifact, requireMac, runChecked } from './build'
import { androidApp, iosApp } from './config'

/**
 * Put the app on a device and drive it: install, launch, uninstall, clear. Phase 2 (`kit qa`,
 * `kit shots`) calls these. Every command a function would run is also available as a plan, so
 * `--dry-run` prints exactly what a real run executes.
 */

type Env = Pick<DeviceEnv, 'root' | 'config' | 'log'>
type Kind = 'simulator' | 'physical' | 'android'

/** Stands in for the device in a dry-run plan when none is running (a dry run boots nothing). */
export const DEVICE_PLACEHOLDER = '<device>'

/** An iOS id that is not a known simulator UDID is a physical iPhone or iPad. */
export async function deviceKind(target: DeviceTarget, device: string): Promise<Kind> {
  if (target === 'android') return 'android'
  if (device === DEVICE_PLACEHOLDER) return 'simulator'
  requireMac('iOS devices')
  return (await listSimulators()).some((sim) => sim.udid === device) ? 'simulator' : 'physical'
}

/** `.apk`, `.aab`, `.app` or `.ipa`, or a usage error. */
function artifactExt(artifact: string, target: DeviceTarget): string {
  const ext = extname(artifact)
  const ok = target === 'android' ? ['.apk', '.aab'] : ['.app', '.ipa']
  if (!ok.includes(ext)) {
    throw new KitError(
      `Cannot install ${artifact} on ${target}`,
      `Pass a ${ok.join(' or ')} with --file`,
      ExitCode.usage,
    )
  }
  return ext
}

function bundletool(): string {
  if (Bun.which('bundletool') === null) {
    throw new KitError('bundletool not found on PATH', 'brew install bundletool', ExitCode.precondition)
  }
  return 'bundletool'
}

/** The commands that install `artifact`. An `.aab` goes through a device-specific `.apks` at `apks`. */
export function installCommands(
  env: Pick<DeviceEnv, 'root' | 'config'>,
  target: DeviceTarget,
  kind: Kind,
  device: string,
  artifact: string,
  apks: string,
): string[][] {
  const ext = artifactExt(artifact, target)
  if (target === 'android') {
    if (ext === '.apk') return [[adb(env), '-s', device, 'install', '-r', artifact]]
    // bundletool finds adb on PATH or under ANDROID_HOME only; kit may have found it in local.properties' SDK.
    const adbFlag = isAbsolute(adb(env)) ? [`--adb=${adb(env)}`] : []
    return [
      [
        bundletool(),
        'build-apks',
        '--connected-device',
        `--device-id=${device}`,
        `--bundle=${artifact}`,
        `--output=${apks}`,
        '--overwrite',
        ...adbFlag,
      ],
      [bundletool(), 'install-apks', `--apks=${apks}`, `--device-id=${device}`, ...adbFlag],
    ]
  }
  if (kind === 'physical')
    return [['xcrun', 'devicectl', 'device', 'install', 'app', '--device', device, artifact]]
  if (ext === '.ipa') {
    throw new KitError(
      'A simulator cannot install an .ipa',
      'Pass the simulator .app with --file, or a physical device with --device',
      ExitCode.usage,
    )
  }
  return [['xcrun', 'simctl', 'install', device, artifact]]
}

const bundleIdOf = (env: Env): string => iosApp(env.config).bundleId

export function launchCommand(env: Env, target: DeviceTarget, kind: Kind, device: string): string[] {
  if (target === 'android') {
    return [
      adb(env),
      '-s',
      device,
      'shell',
      'monkey',
      '-p',
      androidApp(env.config).packageName,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]
  }
  return kind === 'physical'
    ? ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', device, bundleIdOf(env)]
    : ['xcrun', 'simctl', 'launch', device, bundleIdOf(env)]
}

export function uninstallCommand(env: Env, target: DeviceTarget, kind: Kind, device: string): string[] {
  if (target === 'android') return [adb(env), '-s', device, 'uninstall', androidApp(env.config).packageName]
  return kind === 'physical'
    ? ['xcrun', 'devicectl', 'device', 'uninstall', 'app', '--device', device, bundleIdOf(env)]
    : ['xcrun', 'simctl', 'uninstall', device, bundleIdOf(env)]
}

// ---- device choice ----------------------------------------------------------------------------

/**
 * The device for a command that must not boot one (`uninstall`, `clear`): `--device`, or the
 * running one. None running is a precondition failure naming the command that boots one.
 */
export async function requireRunningDevice(
  env: DeviceEnv,
  target: DeviceTarget,
  flag?: string,
): Promise<string> {
  if (flag === undefined || flag === '') {
    if ((await listDevices(env, target)).length === 0) {
      throw new KitError(`No ${target} device is running`, `kit device boot ${target}`, ExitCode.precondition)
    }
  }
  return await resolveDevice(env, target, flag)
}

// ---- install / run ----------------------------------------------------------------------------

export interface RunAppOptions {
  device?: string
  /** Install this apk, aab, app or ipa instead of building. */
  file?: string
  /** Install the newest existing build instead of building. */
  noBuild?: boolean
  /** Launch after installing. */
  launch?: boolean
}

export interface RunAppResult {
  device: string
  /** Absent in a dry run that would build: the build has not made it yet. */
  artifact?: string
  /** Every command, in order: the build, the install and the launch. */
  plan: string[][]
  launched: boolean
}

/** Install (and optionally launch) the app: resolve the device, then build unless told otherwise. */
export async function runApp(
  env: DeviceEnv,
  target: DeviceTarget,
  opts: RunAppOptions,
): Promise<RunAppResult> {
  const platform = platformOf(target)
  const dry = env.flags.dryRun
  // Everything that can fail without a device fails before one is booted.
  if (opts.file) {
    if (!existsSync(resolve(env.root, opts.file))) {
      throw new KitError(`${opts.file} not found`, undefined, ExitCode.usage)
    }
    if (artifactExt(opts.file, target) === '.aab') bundletool()
  } else if (opts.noBuild) {
    const pre = buildPlan(env.root, env.config, platform, {})
    if (findArtifact(pre.artifactDir, pre.ext) === undefined) {
      throw new KitError(
        `No ${pre.ext} to install in ${pre.artifactDir}`,
        `Run \`kit app build ${platform}\` first, or drop --no-build`,
        ExitCode.precondition,
      )
    }
  }
  let device: string
  if (dry && !opts.device && (await listDevices(env, target)).length === 0) device = DEVICE_PLACEHOLDER
  else device = await resolveDevice(env, target, opts.device)
  const kind = await deviceKind(target, device)

  if (kind === 'physical' && !opts.file) {
    throw new KitError(
      'kit builds a simulator app, which a physical device cannot run',
      'Pass --file <path to a device .app or .ipa>',
      ExitCode.usage,
    )
  }

  const plan: string[][] = []
  const build = buildPlan(env.root, env.config, platform, {
    device: kind === 'simulator' ? device : undefined,
  })
  let artifact: string | undefined
  if (opts.file) {
    artifact = resolve(env.root, opts.file)
    if (!existsSync(artifact)) throw new KitError(`${opts.file} not found`, undefined, ExitCode.usage)
  } else if (opts.noBuild) {
    artifact = findArtifact(build.artifactDir, build.ext)
    if (artifact === undefined) {
      throw new KitError(
        `No ${build.ext} to install in ${build.artifactDir}`,
        `Run \`kit app build ${platform}\` first, or drop --no-build`,
        ExitCode.precondition,
      )
    }
  } else if (dry) {
    plan.push(build.cmd)
  } else {
    const built = await buildApp(env, platform, { device: kind === 'simulator' ? device : undefined })
    artifact = built.artifact
    plan.push(built.cmd)
  }

  const shown = artifact ?? join(build.artifactDir, `*${build.ext}`)
  const needsApks = extname(shown) === '.aab'
  const work = needsApks && !dry ? mkdtempSync(join(tmpdir(), 'kit-app-')) : tmpdir()
  const dropWork =
    needsApks && !dry ? onCleanup(() => rmSync(work, { recursive: true, force: true })) : undefined
  try {
    const toRun = installCommands(env, target, kind, device, shown, join(work, 'app.apks'))
    if (opts.launch) toRun.push(launchCommand(env, target, kind, device))
    plan.push(...toRun)
    if (dry) return { device, artifact, plan, launched: false }
    for (const cmd of toRun) {
      env.log.step(cmd.join(' '))
      await runChecked(cmd)
    }
    return { device, artifact, plan, launched: opts.launch === true }
  } finally {
    if (needsApks && !dry) rmSync(work, { recursive: true, force: true })
    dropWork?.()
  }
}

/**
 * What `clear` deletes inside a simulator data container: everything but the container manager's
 * own metadata. Refuses a path that is not this simulator's app data container, whatever simctl printed.
 */
export function containerEntries(dir: string, device: string): string[] {
  const real = existsSync(dir) ? realpathSync(dir) : dir
  const inside = new RegExp(`/CoreSimulator/Devices/${device}/data/Containers/Data/Application/[^/]+/?$`, 'i')
  if (!inside.test(real)) {
    throw new KitError(`Refusing to clear ${real}`, `It is not an app data container of simulator ${device}`)
  }
  return readdirSync(real).filter((name) => !name.startsWith('.com.apple.'))
}

// ---- uninstall / clear ------------------------------------------------------------------------

export interface ManageResult {
  device: string
  plan: string[][]
}

export async function uninstallApp(
  env: DeviceEnv,
  target: DeviceTarget,
  device: string,
): Promise<ManageResult> {
  const kind = await deviceKind(target, device)
  const cmd = uninstallCommand(env, target, kind, device)
  if (!env.flags.dryRun) {
    env.log.step(cmd.join(' '))
    await runChecked(cmd)
  }
  return { device, plan: [cmd] }
}

/** Wipe the app's data and keep it installed. */
export async function clearApp(env: DeviceEnv, target: DeviceTarget, device: string): Promise<ManageResult> {
  const kind = await deviceKind(target, device)
  if (target === 'android') {
    const cmd = [adb(env), '-s', device, 'shell', 'pm', 'clear', androidApp(env.config).packageName]
    if (!env.flags.dryRun) {
      env.log.step(cmd.join(' '))
      await runChecked(cmd)
    }
    return { device, plan: [cmd] }
  }
  if (kind === 'physical') {
    throw new KitError(
      'kit cannot clear the data of an app on a physical device',
      'Use `kit app uninstall` and install again',
      ExitCode.precondition,
    )
  }
  const bundleId = bundleIdOf(env)
  const terminate = ['xcrun', 'simctl', 'terminate', device, bundleId]
  const container = ['xcrun', 'simctl', 'get_app_container', device, bundleId, 'data']
  const plan = [
    terminate,
    container,
    ['find', '<data container>', '-mindepth', '1', '-maxdepth', '1', '!', '-name', '.com.apple.*', '-delete'],
  ]
  if (env.flags.dryRun) return { device, plan }
  env.log.step(terminate.join(' '))
  await quietCapture(terminate) // not running is fine
  env.log.step(container.join(' '))
  const { code, stdout } = await quietCapture(container)
  const dir = stdout.trim()
  if (code !== 0 || dir === '') {
    throw new KitError(
      `${bundleId} is not installed on ${device}`,
      'Run `kit app install ios`',
      ExitCode.precondition,
    )
  }
  for (const entry of containerEntries(dir, device))
    rmSync(join(dir, entry), { recursive: true, force: true })
  return { device, plan }
}
