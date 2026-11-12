import { type DeviceEnv, type DeviceTarget, platformOf } from '../devices'
import { ExitCode, KitError } from '../errors'
import { dumpAndroid, loadAndroid } from './android'
import { fixtureConfig, requireFixtureDir } from './config'
import { dumpIos, loadIos } from './ios'

/**
 * Fixtures: app state (databases, files) replayed onto a simulator or device, or captured from it.
 * kit owns the transport; what travels is `fixtures.files` in kit.config.ts.
 */

export interface FixtureResult {
  fixture: string
  device: string
  /** How the files reached the app: the simulator container, `run-as`, or a rooted adb. */
  via: 'simctl' | 'run-as' | 'root'
  /** Repo-relative (dump) or in-app (load) paths written. */
  files: string[]
  /** What a `--dry-run` would do; absent after a real run. */
  plan?: string[]
}

export { fixtureConfig, listFixtures, resolveFixtureName } from './config'

/**
 * Why `device` cannot take a fixture. kit takes any id that is not a simulator UDID for a physical
 * device, so a simulator's name or a mistyped id gets its own message, not "physical".
 */
export function notASimulator(
  device: string,
  simulators: readonly { readonly udid: string; readonly name: string }[],
): KitError {
  const named = simulators.find((sim) => sim.name === device)
  if (named) {
    return new KitError(
      `${device} is a simulator's name; fixtures need its UDID`,
      `--device ${named.udid}`,
      ExitCode.usage,
    )
  }
  return new KitError(
    `No simulator has the UDID ${device}`,
    '`kit device list` shows them. kit cannot copy fixtures to or from a physical iPhone or iPad',
    ExitCode.precondition,
  )
}

async function requireSimulator(target: DeviceTarget, device: string): Promise<void> {
  if (platformOf(target) !== 'ios') return
  const { deviceKind } = await import('../app/install')
  if ((await deviceKind(target, device)) !== 'physical') return
  const { listSimulators } = await import('../devices')
  throw notASimulator(device, await listSimulators())
}

/** Replay `<fixtures.dir>/<name>` onto `device`. The app must be installed; it is stopped first. */
export async function loadFixture(
  env: DeviceEnv,
  target: DeviceTarget,
  device: string,
  name: string,
): Promise<FixtureResult> {
  const cfg = fixtureConfig(env.root, env.config)
  const source = requireFixtureDir(cfg, name)
  await requireSimulator(target, device)
  return platformOf(target) === 'android'
    ? await loadAndroid(env, device, name, cfg, source)
    : await loadIos(env, device, name, cfg, source)
}

/** Capture the app's state from `device` into `<fixtures.dir>/<name>`, replacing it only when complete. */
export async function dumpFixture(
  env: DeviceEnv,
  target: DeviceTarget,
  device: string,
  name: string,
): Promise<FixtureResult> {
  const cfg = fixtureConfig(env.root, env.config)
  await requireSimulator(target, device)
  return platformOf(target) === 'android'
    ? await dumpAndroid(env, device, name, cfg)
    : await dumpIos(env, device, name, cfg)
}
