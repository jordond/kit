import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Flags } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import type { Logger } from '../log'
import { exitOf, runPiped, spawnDetached } from '../proc'
import { confirm, select } from '../prompt'
import {
  type DeviceOption,
  isIpadName,
  latestLargestIpad,
  latestLargestIphone,
  latestLargestPixel,
  latestVersion,
  preferredAmong,
  preferredSystemImage,
  type SimFamily,
  type SystemImage,
  systemImagePackage,
} from './pick'

/**
 * Device discovery, selection and boot for the commands that target one phone, simulator or
 * emulator (ported from brewd `lib/devices.ts`). kit owns the device lifecycle: simctl, adb,
 * emulator and avdmanager, never `maestro start-device`.
 *
 * Probes keep stderr quiet: "is the emulator up yet" is a question, not a failure.
 */

export type { DeviceOption, SimFamily } from './pick'

/** What a device command targets. `ipad` is iOS with the iPad simulator family. */
export const deviceTargets = ['ios', 'ipad', 'android'] as const
export type DeviceTarget = (typeof deviceTargets)[number]
export type Platform = 'ios' | 'android'

export const platformOf = (target: DeviceTarget): Platform => (target === 'android' ? 'android' : 'ios')
export const familyOf = (target: DeviceTarget): SimFamily => (target === 'ipad' ? 'ipad' : 'iphone')

/** What every device function needs from the command context (`ctx` satisfies it after requireProject). */
export interface DeviceEnv {
  root: string
  config: KitConfig
  flags: Flags
  log: Logger
}

/** The `<ios|ipad|android>` positional. `allowed` narrows it (`kit app build` takes no `ipad`). */
export function parseTarget<T extends DeviceTarget = DeviceTarget>(
  value: string | undefined,
  command: string,
  allowed: readonly T[] = deviceTargets as unknown as readonly T[],
): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new KitError(
      value === undefined ? `kit ${command} needs a platform` : `Unknown platform "${value}"`,
      `kit ${command} <${allowed.join('|')}>`,
      ExitCode.usage,
    )
  }
  return value as T
}

export async function quietCapture(
  cmd: readonly string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<{ code: number; stdout: string }> {
  try {
    const { code, stdout } = await runPiped(cmd, opts)
    return { code, stdout }
  } catch {
    // The binary is not there (ENOENT): same answer as a failed probe.
    return { code: 127, stdout: '' }
  }
}

function requireMac(what: string): void {
  if (process.platform !== 'darwin') {
    throw new KitError(`${what} needs macOS (Xcode simulators)`, undefined, ExitCode.precondition)
  }
}

// ---- Android SDK ------------------------------------------------------------------------------

/**
 * Where the SDK lives: the env vars Gradle honours, then `sdk.dir` in the Gradle root's
 * local.properties, then the Android Studio default for this OS.
 */
export function androidSdkDir(root: string, config: KitConfig): string {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (fromEnv) return fromEnv
  const props = join(root, config.gradle?.root ?? config.toolchain?.root ?? '.', 'local.properties')
  if (existsSync(props)) {
    const dir = /^\s*sdk\.dir\s*=\s*(.+?)\s*$/m.exec(readFileSync(props, 'utf8'))?.[1]
    if (dir) return dir
  }
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Android', 'sdk')
    : join(homedir(), 'Android', 'Sdk')
}

/** An SDK tool: the one on PATH, else the SDK's copy at `sdkPath`; undefined when neither exists. */
export function findSdkTool(
  env: Pick<DeviceEnv, 'root' | 'config'>,
  bin: string,
  ...sdkPath: string[]
): string | undefined {
  if (Bun.which(bin)) return bin
  const path = join(androidSdkDir(env.root, env.config), ...sdkPath)
  return existsSync(path) ? path : undefined
}

/** Where each SDK tool sits under the SDK dir. */
export const SDK_TOOLS = {
  adb: ['platform-tools', 'adb'],
  emulator: ['emulator', 'emulator'],
  avdmanager: ['cmdline-tools', 'latest', 'bin', 'avdmanager'],
} as const

function sdkTool(env: Pick<DeviceEnv, 'root' | 'config'>, bin: keyof typeof SDK_TOOLS): string {
  const found = findSdkTool(env, bin, ...SDK_TOOLS[bin])
  if (found) return found
  throw new KitError(
    `${bin} not found on PATH or under ${androidSdkDir(env.root, env.config)}`,
    'Install the Android SDK (platform-tools, emulator, cmdline-tools) and set ANDROID_HOME; see `kit doctor`',
    ExitCode.precondition,
  )
}

/** `adb`: PATH first, then `<sdk>/platform-tools/adb`. */
export const adb = (env: Pick<DeviceEnv, 'root' | 'config'>): string => sdkTool(env, 'adb')
const emulatorBin = (env: Pick<DeviceEnv, 'root' | 'config'>): string => sdkTool(env, 'emulator')
const avdmanagerBin = (env: Pick<DeviceEnv, 'root' | 'config'>): string => sdkTool(env, 'avdmanager')

function avdHome(): string {
  return process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd')
}

/** The system image ABI this machine runs without translation. */
export function hostAbi(): string {
  return process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
}

// ---- listing ----------------------------------------------------------------------------------

export interface DeviceInfo {
  /** What `--device` takes: a simulator UDID, an adb serial, or (not running) an AVD name. */
  id: string
  name: string
  platform: Platform
  kind: 'simulator' | 'emulator' | 'physical'
  state: 'booted' | 'shutdown'
  /** iOS runtime version (`26.1`), when known. */
  os?: string
}

/** Running Android devices and emulators, as `adb devices -l` lists them. */
export async function listAndroidDevices(env: Pick<DeviceEnv, 'root' | 'config'>): Promise<DeviceOption[]> {
  const { code, stdout } = await quietCapture([adb(env), 'devices', '-l'])
  if (code !== 0) throw new KitError('adb devices failed', 'Is adb installed? See `kit doctor`')
  return (
    stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      // The state is the second column; `offline` and `unauthorized` lines also carry a `device:` field.
      .filter((line) => line.split(/\s+/)[1] === 'device')
      .map((line) => {
        const serial = line.split(/\s+/)[0]!
        const model = /model:(\S+)/.exec(line)?.[1]?.replaceAll('_', ' ')
        return { id: serial, label: model === undefined ? serial : `${serial} (${model})` }
      })
  )
}

interface SimctlDevice {
  readonly udid: string
  readonly name: string
  readonly state: string
  readonly isAvailable: boolean
  readonly deviceTypeIdentifier: string
}

async function simctlJson<T>(what: string): Promise<T> {
  requireMac('iOS')
  const { code, stdout } = await quietCapture(['xcrun', 'simctl', 'list', what, '-j'])
  if (code !== 0) {
    throw new KitError(
      `simctl list ${what} failed`,
      'Are the Xcode command line tools installed? See `kit doctor`',
      ExitCode.precondition,
    )
  }
  return JSON.parse(stdout) as T
}

/** Every simulator simctl knows, each with its runtime identifier. */
export async function listSimulators(): Promise<(SimctlDevice & { readonly runtime: string })[]> {
  const parsed = await simctlJson<{ devices?: Record<string, SimctlDevice[]> }>('devices')
  return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) =>
    devices.map((device) => ({ ...device, runtime })),
  )
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-1` → `26.1`. */
const runtimeVersion = (runtime: string): string | undefined =>
  /iOS-(\d+(?:-\d+)*)$/.exec(runtime)?.[1]?.replaceAll('-', '.')

/** A paired Watch, an Apple TV or a Vision Pro simulator is not something an iOS app installs on. */
const isIosRuntime = (runtime: string): boolean => /SimRuntime\.iOS-/.test(runtime)

/** Running devices of a target: what a command can drive right now. */
export async function listDevices(
  env: Pick<DeviceEnv, 'root' | 'config'>,
  target: DeviceTarget,
): Promise<DeviceOption[]> {
  if (target === 'android') return await listAndroidDevices(env)
  return (await listSimulators())
    .filter((sim) => sim.state === 'Booted' && isIosRuntime(sim.runtime))
    .filter((sim) => isIpadName(sim.name) === (target === 'ipad'))
    .map((sim) => ({ id: sim.udid, label: `${sim.name} (${sim.udid})` }))
}

/** Running devices first, then the ones kit could boot: available simulators, or AVDs that are not up. */
export async function listAllDevices(
  env: Pick<DeviceEnv, 'root' | 'config'>,
  target: DeviceTarget,
): Promise<DeviceInfo[]> {
  if (target !== 'android') {
    return (await listSimulators())
      .filter((sim) => sim.isAvailable && isIpadName(sim.name) === (target === 'ipad'))
      .filter((sim) => isIosRuntime(sim.runtime))
      .map(
        (sim): DeviceInfo => ({
          id: sim.udid,
          name: sim.name,
          platform: 'ios',
          kind: 'simulator',
          state: sim.state === 'Booted' ? 'booted' : 'shutdown',
          os: runtimeVersion(sim.runtime),
        }),
      )
      .sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted'))
  }
  const running: DeviceInfo[] = []
  const up = new Set<string>()
  for (const device of await listAndroidDevices(env)) {
    const emulator = device.id.startsWith('emulator-')
    const avd = emulator ? await avdOf(env, device.id) : undefined
    if (avd) up.add(avd)
    running.push({
      id: device.id,
      name: avd ?? device.label.replace(/^\S+ \((.*)\)$/, '$1'),
      platform: 'android',
      kind: emulator ? 'emulator' : 'physical',
      state: 'booted',
    })
  }
  // No emulator binary: there are no AVDs to offer, only what adb sees.
  const avds = await listAvds(env).catch(() => [])
  return [
    ...running,
    ...avds
      .filter((avd) => !up.has(avd))
      .map(
        (avd): DeviceInfo => ({
          id: avd,
          name: avd,
          platform: 'android',
          kind: 'emulator',
          state: 'shutdown',
        }),
      ),
  ]
}

// ---- resolve ----------------------------------------------------------------------------------

/**
 * The device to drive: `--device` verbatim, a lone running one silently, a picker when several are
 * up, and when none is, an offer to boot (or first create) the newest, largest phone or iPad.
 * `--yes` answers every question the way an unattended run needs: the preferred one of several,
 * and boot without asking. Under `--dry-run` nothing boots; the id names what would.
 */
export async function resolveDevice(env: DeviceEnv, target: DeviceTarget, flag?: string): Promise<string> {
  if (flag !== undefined && flag !== '') return flag
  const devices = await listDevices(env, target)
  if (devices.length === 0) return await bootDevice(env, target)
  const [only] = devices
  if (devices.length === 1 && only !== undefined) {
    env.log.step(`using ${only.label}`)
    return only.id
  }
  const preferred = preferredAmong(platformOf(target), devices, familyOf(target))
  if (env.flags.yes) {
    env.log.step(`using ${preferred.label}`)
    return preferred.id
  }
  if (!env.flags.interactive) {
    throw new KitError(
      `Several devices are up: ${devices.map((d) => d.label).join(', ')}`,
      `Pick one with --device, or --yes takes ${preferred.label}`,
      ExitCode.usage,
    )
  }
  return await select(
    env.flags,
    'Which device?',
    devices.map((d) => ({ value: d.id, label: d.label })),
    { initial: preferred.id },
  )
}

async function confirmBoot(env: DeviceEnv, question: string): Promise<void> {
  // A dry run boots nothing, so there is nothing to agree to.
  if (env.flags.yes || env.flags.dryRun) {
    env.log.step(question)
    return
  }
  if (!(await confirm(env.flags, question, { initial: true }))) {
    throw new KitError('No device to drive', undefined, ExitCode.interrupted)
  }
}

const POLL_MS = 2000
/** KIT_DEVICE_TIMEOUT_MS overrides the four minutes a boot may take (slow CI runners). */
const bootTimeout = (): number => Number(process.env.KIT_DEVICE_TIMEOUT_MS) || 4 * 60 * 1000

async function pollUntil(
  what: string,
  probe: () => Promise<boolean>,
  /** Throws when what is being waited on can no longer happen (the emulator process died). */
  check?: () => void,
): Promise<void> {
  const deadline = Date.now() + bootTimeout()
  for (;;) {
    if (await probe()) return
    check?.()
    if (Date.now() >= deadline) throw new KitError(`Gave up waiting for ${what}`)
    await Bun.sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())))
  }
}

/**
 * Boot a device and return its id (UDID or adb serial). Without `name`: the newest, largest iPhone,
 * iPad or Pixel, created first when it does not exist. With `name`: that simulator (name or UDID)
 * or AVD. A device already up is returned as is.
 */
export async function bootDevice(env: DeviceEnv, target: DeviceTarget, name?: string): Promise<string> {
  return target === 'android'
    ? await bootEmulator(env, name)
    : await bootSimulator(env, familyOf(target), name)
}

// ---- Android ----------------------------------------------------------------------------------

async function listAvds(env: Pick<DeviceEnv, 'root' | 'config'>): Promise<string[]> {
  const emulator = emulatorBin(env)
  const { code, stdout } = await quietCapture([emulator, '-list-avds'])
  if (code !== 0) throw new KitError(`${emulator} -list-avds failed`)
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(INFO|WARNING|ERROR)\b/.test(line))
}

/** The `hw.device.name` an AVD was created from, read off its config.ini. */
function avdDeviceName(avd: string): string | undefined {
  const ini = join(avdHome(), `${avd}.avd`, 'config.ini')
  if (!existsSync(ini)) return undefined
  return /^hw\.device\.name\s*=\s*(.+)$/m.exec(readFileSync(ini, 'utf8'))?.[1]?.trim()
}

export function installedSystemImages(sdk: string): SystemImage[] {
  const root = join(sdk, 'system-images')
  if (!existsSync(root)) return []
  const dirs = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  const images: SystemImage[] = []
  for (const apiDir of dirs(root)) {
    const api = /^android-(.+)$/.exec(apiDir)?.[1]
    if (api === undefined) continue
    for (const tag of dirs(join(root, apiDir))) {
      for (const abi of dirs(join(root, apiDir, tag))) {
        if (existsSync(join(root, apiDir, tag, abi, 'system.img'))) images.push({ api, tag, abi })
      }
    }
  }
  return images
}

/** Set or replace keys in an emulator config.ini: a duplicate key is whichever line the emulator reads last. */
export function setIniKeys(text: string, values: Readonly<Record<string, string>>): string {
  let out = text
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`
    const pattern = new RegExp(`^${key.replaceAll('.', '\\.')}\\s*=.*$`, 'm')
    out = pattern.test(out) ? out.replace(pattern, line) : `${out.trimEnd()}\n${line}\n`
  }
  return out
}

async function createAvd(env: DeviceEnv, name: string, device: string, image: SystemImage): Promise<void> {
  const cmd = [avdmanagerBin(env), 'create', 'avd', '-n', name, '-k', systemImagePackage(image), '-d', device]
  // avdmanager asks whether to write a custom hardware profile; the device definition is the profile.
  const { code, stdout, stderr } = await runPiped(cmd, { input: 'no\n' })
  if (code !== 0) throw new KitError(`avdmanager could not create ${name}`, (stderr || stdout).trim())
  // The default data partition fills with one fixture's photos and a map's tiles; a keyboard lets
  // Maestro type instead of tapping the soft one.
  const ini = join(avdHome(), `${name}.avd`, 'config.ini')
  if (existsSync(ini)) {
    writeFileSync(
      ini,
      setIniKeys(readFileSync(ini, 'utf8'), { 'disk.dataPartition.size': '8G', 'hw.keyboard': 'yes' }),
    )
  }
}

/** The AVD a running emulator was started from. */
async function avdOf(env: Pick<DeviceEnv, 'root' | 'config'>, serial: string): Promise<string | undefined> {
  const { code, stdout } = await quietCapture([adb(env), '-s', serial, 'emu', 'avd', 'name'])
  const name = stdout.split('\n')[0]?.trim()
  return code === 0 && name ? name : undefined
}

/** The adb serial an emulator came up on, by asking each emulator for its AVD name. */
export async function emulatorSerial(
  env: Pick<DeviceEnv, 'root' | 'config'>,
  avd: string,
): Promise<string | undefined> {
  for (const device of await listAndroidDevices(env)) {
    if (!device.id.startsWith('emulator-')) continue
    if ((await avdOf(env, device.id)) === avd) return device.id
  }
  return undefined
}

const pixelLabel = (device: string): string =>
  device
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(' Xl', ' XL')

async function bootEmulator(env: DeviceEnv, name?: string): Promise<string> {
  const sdk = androidSdkDir(env.root, env.config)
  const emulator = emulatorBin(env)
  const avds = await listAvds(env)
  let avd: string
  let label: string
  let create: { device: string; image: SystemImage } | undefined

  if (name !== undefined) {
    if (!avds.includes(name)) {
      throw new KitError(
        `No emulator named "${name}"`,
        avds.length
          ? `AVDs: ${avds.join(', ')}`
          : 'No AVDs exist; run `kit device boot android` to create one',
        ExitCode.usage,
      )
    }
    avd = name
    label = name
    const serial = await emulatorSerial(env, avd)
    if (serial !== undefined) {
      env.log.step(`using ${serial} (${label})`)
      return serial
    }
    await confirmBoot(env, `Boot the ${label} emulator?`)
  } else {
    const { stdout } = await quietCapture([avdmanagerBin(env), 'list', 'device', '-c'])
    const device = latestLargestPixel(stdout.split('\n').map((line) => line.trim()))
    if (device === undefined) {
      throw new KitError(
        'avdmanager lists no Pixel device definition',
        'Is cmdline-tools installed under the SDK? (sdkmanager "cmdline-tools;latest")',
        ExitCode.precondition,
      )
    }
    label = pixelLabel(device)
    const existing = avds.find((a) => avdDeviceName(a) === device)
    if (existing === undefined) {
      const image = preferredSystemImage(installedSystemImages(sdk), hostAbi())
      if (image === undefined) {
        throw new KitError(
          `No ${hostAbi()} phone system image installed under ${sdk}`,
          `sdkmanager "system-images;android-36;google_apis_playstore;${hostAbi()}"`,
          ExitCode.precondition,
        )
      }
      avd = `kit_${device}`
      create = { device, image }
      await confirmBoot(
        env,
        `No Android device connected. Create a ${label} emulator (${avd}) on ${systemImagePackage(image)} and boot it?`,
      )
    } else {
      avd = existing
      await confirmBoot(env, `No Android device connected. Boot the ${label} emulator (${avd})?`)
    }
  }

  if (env.flags.dryRun) return avd
  if (create) await createAvd(env, avd, create.device, create.image)

  const headless = env.flags.ci ? ['-no-window', '-no-audio', '-no-boot-anim'] : []
  const logFile = join(tmpdir(), `kit-emulator-${avd}.log`)
  const proc = spawnDetached([emulator, '-avd', avd, ...headless], logFile)
  // An emulator that dies at once (no hypervisor, a locked AVD) would otherwise cost the whole timeout.
  const alive = (): void => {
    const exit = exitOf(proc)
    if (exit === undefined) return
    const tail = existsSync(logFile)
      ? readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n')
      : ''
    throw new KitError(`The ${avd} emulator exited (${exit})`, tail || `See ${logFile}`)
  }
  env.log.dim(`  booting ${avd}…`)
  let serial: string | undefined
  await pollUntil(
    `${avd} to appear in adb devices`,
    async () => {
      serial = await emulatorSerial(env, avd)
      return serial !== undefined
    },
    alive,
  )
  const found = serial!
  await pollUntil(
    `${avd} to finish booting`,
    async () => {
      const { stdout } = await quietCapture([adb(env), '-s', found, 'shell', 'getprop', 'sys.boot_completed'])
      return stdout.trim() === '1'
    },
    alive,
  )
  env.log.step(`using ${found} (${label})`)
  return found
}

// ---- iOS --------------------------------------------------------------------------------------

interface SimctlRuntime {
  readonly identifier: string
  readonly version: string
  readonly platform?: string
  readonly isAvailable: boolean
}

interface SimctlDeviceType {
  readonly identifier: string
  readonly name: string
  readonly productFamily: string
}

async function bootSimulator(env: DeviceEnv, family: SimFamily, name?: string): Promise<string> {
  const sims = await listSimulators()
  let udid: string | undefined
  let label: string
  let create: { name: string; type: string; runtime: string } | undefined

  if (name !== undefined) {
    const matches = sims.filter((s) => s.isAvailable && (s.udid === name || s.name === name))
    const sim = matches.find((s) => s.state === 'Booted') ?? latestRuntime(matches)
    if (sim === undefined) {
      throw new KitError(
        `No simulator named "${name}"`,
        'List them with `kit device list ios` (or ipad)',
        ExitCode.usage,
      )
    }
    udid = sim.udid
    label = `${sim.name}${runtimeVersion(sim.runtime) ? ` on iOS ${runtimeVersion(sim.runtime)}` : ''}`
    if (sim.state === 'Booted') {
      env.log.step(`using ${label} (${udid})`)
      return udid
    }
    await confirmBoot(env, `Boot the ${label} (${udid})?`)
  } else {
    const { runtimes } = await simctlJson<{ runtimes: SimctlRuntime[] }>('runtimes')
    const runtime = latestVersion(
      runtimes.filter((r) => r.isAvailable && (r.platform ?? 'iOS') === 'iOS' && /iOS/.test(r.identifier)),
    )
    if (runtime === undefined) {
      throw new KitError(
        'No iOS simulator runtime installed',
        'Xcode ▸ Settings ▸ Components, or `xcodebuild -downloadPlatform iOS`',
        ExitCode.precondition,
      )
    }
    const { devicetypes } = await simctlJson<{ devicetypes: SimctlDeviceType[] }>('devicetypes')
    const type =
      family === 'ipad'
        ? latestLargestIpad(devicetypes.filter((t) => t.productFamily === 'iPad'))
        : latestLargestIphone(devicetypes.filter((t) => t.productFamily === 'iPhone'))
    if (type === undefined) {
      throw new KitError(
        `No ${family === 'ipad' ? 'iPad' : 'iPhone'} device type in this Xcode`,
        undefined,
        ExitCode.precondition,
      )
    }
    label = `${type.name} on iOS ${runtime.version}`
    udid = sims.find(
      (sim) =>
        sim.isAvailable &&
        sim.state === 'Shutdown' &&
        sim.deviceTypeIdentifier === type.identifier &&
        sim.runtime === runtime.identifier,
    )?.udid
    if (udid === undefined) {
      create = { name: type.name, type: type.identifier, runtime: runtime.identifier }
      await confirmBoot(
        env,
        `No booted ${family === 'ipad' ? 'iPad' : 'iPhone'} simulator. Create an ${label} and boot it?`,
      )
    } else {
      await confirmBoot(
        env,
        `No booted ${family === 'ipad' ? 'iPad' : 'iPhone'} simulator. Boot the ${label} (${udid})?`,
      )
    }
  }

  if (env.flags.dryRun) return udid ?? create!.name
  if (create) {
    const made = await quietCapture(['xcrun', 'simctl', 'create', create.name, create.type, create.runtime])
    if (made.code !== 0) throw new KitError(`simctl could not create an ${label}`)
    udid = made.stdout.trim()
  }
  const id = udid!
  const boot = await quietCapture(['xcrun', 'simctl', 'boot', id])
  if (boot.code !== 0) throw new KitError(`simctl could not boot ${id}`)
  env.log.dim(`  booting ${label}…`)
  // The Simulator app is what puts the booted device on screen; simctl alone runs it headless.
  if (!env.flags.ci) await quietCapture(['open', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', id])
  const status = await quietCapture(['xcrun', 'simctl', 'bootstatus', id, '-b'])
  if (status.code !== 0) throw new KitError(`${label} did not finish booting`)
  env.log.step(`using ${label} (${id})`)
  return id
}

/** Of simulators with one name, the one on the newest runtime. */
function latestRuntime<T extends { readonly runtime: string }>(sims: readonly T[]): T | undefined {
  return latestVersion(sims.map((sim) => ({ sim, version: runtimeVersion(sim.runtime) ?? '0' })))?.sim
}
