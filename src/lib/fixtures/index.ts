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

async function requireSimulator(target: DeviceTarget, device: string): Promise<void> {
  if (platformOf(target) !== 'ios') return
  const { deviceKind } = await import('../app/install')
  if ((await deviceKind(target, device)) === 'physical') {
    throw new KitError(
      'kit cannot copy fixtures to or from a physical iPhone or iPad',
      'Use a simulator',
      ExitCode.precondition,
    )
  }
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
