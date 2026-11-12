import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { iosApp } from '../app/config'
import { type DeviceEnv, quietCapture } from '../devices'
import { ExitCode, KitError } from '../errors'
import { describeOps, dumpPlan, type FixtureConfig, loadOps, writtenPaths } from './config'
import type { FixtureResult } from './index'
import { commitCapture, hasEntry, runPrepare, stageFixture } from './stage'

/** iOS transport: the simulator's data container is a directory on this Mac, so it is plain file ops. */

/**
 * The real path of an app data container of simulator `udid`. Whatever simctl printed, nothing outside
 * `…/CoreSimulator/Devices/<udid>/data/Containers/Data/Application/<id>/` is ever written or deleted.
 */
export function containerRoot(dir: string, udid: string): string {
  const real = existsSync(dir) ? realpathSync(dir) : dir
  const inside = new RegExp(`/CoreSimulator/Devices/${udid}/data/Containers/Data/Application/[^/]+/?$`, 'i')
  if (!inside.test(real)) {
    throw new KitError(`Refusing to touch ${real}`, `It is not an app data container of simulator ${udid}`)
  }
  return real
}

/** `rel` inside `container`, after resolving symlinks in what exists: a link must not lead out. */
export function containerPath(container: string, rel: string): string {
  const path = resolve(container, rel)
  let probe = path
  while (!existsSync(probe) && probe !== container) probe = dirname(probe)
  const real = realpathSync(probe)
  const within = relative(container, real)
  if (within.startsWith('..') || resolve(container, within) !== real) {
    throw new KitError(`Refusing to touch ${path}`, 'It resolves outside the simulator data container')
  }
  return path
}

async function dataContainer(env: DeviceEnv, device: string): Promise<string> {
  const bundleId = iosApp(env.config).bundleId
  const { code, stdout } = await quietCapture([
    'xcrun',
    'simctl',
    'get_app_container',
    device,
    bundleId,
    'data',
  ])
  if (code !== 0 || stdout.trim() === '') {
    throw new KitError(
      `${bundleId} is not installed on ${device}`,
      'kit app install ios',
      ExitCode.precondition,
    )
  }
  return containerRoot(stdout.trim(), device)
}

const terminate = (env: DeviceEnv, device: string) =>
  quietCapture(['xcrun', 'simctl', 'terminate', device, iosApp(env.config).bundleId]) // not running is fine

export async function loadIos(
  env: DeviceEnv,
  device: string,
  name: string,
  cfg: FixtureConfig,
  source: string,
): Promise<FixtureResult> {
  const container = await dataContainer(env, device)
  if (env.flags.dryRun) {
    const ops = loadOps(cfg, 'ios', (e) => hasEntry(source, e))
    return { fixture: name, device, via: 'simctl', files: writtenPaths(ops), plan: describeOps(ops) }
  }
  env.log.step(`stopping ${iosApp(env.config).bundleId}`)
  await terminate(env, device)
  const staged = stageFixture(source)
  try {
    await runPrepare(cfg, staged.dir, { name, platform: 'ios', root: env.root })
    const ops = loadOps(cfg, 'ios', (e) => hasEntry(staged.dir, e))
    // Resolve every destination before the first write: a bad one must not leave a half-loaded app.
    const targets = ops.map((o) => containerPath(container, o.op === 'remove' ? o.path : o.to))
    ops.forEach((o, i) => {
      const to = targets[i]!
      if (o.op === 'remove') {
        rmSync(to, { recursive: true, force: true })
      } else if (o.dir) {
        mkdirSync(to, { recursive: true })
        cpSync(join(staged.dir, o.from), to, { recursive: true })
      } else {
        mkdirSync(dirname(to), { recursive: true })
        cpSync(join(staged.dir, o.from), to)
      }
    })
    return { fixture: name, device, via: 'simctl', files: writtenPaths(ops) }
  } finally {
    staged.dispose()
  }
}

export async function dumpIos(
  env: DeviceEnv,
  device: string,
  name: string,
  cfg: FixtureConfig,
): Promise<FixtureResult> {
  const container = await dataContainer(env, device)
  if (env.flags.dryRun) {
    return { fixture: name, device, via: 'simctl', ...dumpPlan(cfg, 'ios', name) }
  }
  await terminate(env, device)
  const files = commitCapture(cfg, 'ios', name, container)
  return { fixture: name, device, via: 'simctl', files }
}
