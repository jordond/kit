import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { androidApp } from '../app/config'
import { onCleanup } from '../cleanup'
import { adb, type DeviceEnv, emulatorSerial, listAndroidDevices, quietCapture } from '../devices'
import { ExitCode, KitError } from '../errors'
import { childEnv, runPiped } from '../proc'
import {
  describeOps,
  destOf,
  dumpPlan,
  entriesFor,
  type FixtureConfig,
  type LoadOp,
  loadOps,
  writtenPaths,
} from './config'
import type { FixtureResult } from './index'
import { commitCapture, hasEntry, runPrepare, stageFixture } from './stage'

/** Android transport: files staged in /data/local/tmp, copied into the app's data dir by the app or by root. */

/** Single-quote `value` for a POSIX shell: nothing in it can end the quoting or expand. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export const deviceTmpDir = (pkg: string): string => `/data/local/tmp/kit-fixture-${pkg}`

/**
 * The device-side script of a load. Paths are relative to the data dir: `run-as` starts there, and
 * the root variant `cd`s there. Copying as root leaves root-owned files the app cannot open and
 * files labelled for /data/local/tmp, so the root variant puts the owner and the SELinux labels back.
 */
export function androidLoadScript(o: {
  ops: readonly LoadOp[]
  tmp: string
  data: string
  root: boolean
}): string {
  const q = shQuote
  const lines = ['set -e']
  if (o.root) lines.push(`cd ${q(o.data)}`)
  for (const op of o.ops) {
    if (op.op === 'remove') {
      lines.push(`rm -rf -- ${q(op.path)}`)
    } else if (op.dir) {
      lines.push(`mkdir -p -- ${q(op.to)}`, `cp -R -- ${q(`${o.tmp}/${op.from}/.`)} ${q(`${op.to}/`)}`)
    } else {
      lines.push(`mkdir -p -- ${q(posix.dirname(op.to))}`, `cp -- ${q(`${o.tmp}/${op.from}`)} ${q(op.to)}`)
    }
  }
  if (o.root) {
    lines.push(
      `chown -R "$(stat -c '%u:%g' ${q(o.data)})" ${q(o.data)}`,
      `restorecon -R ${q(o.data)} || true`,
    )
  }
  return lines.join('\n')
}

/** The device-side script of a dump: tar whichever of `paths` exist to stdout. */
export function androidDumpScript(paths: readonly string[]): string {
  const list = paths.map((p) => shQuote(`./${p}`)).join(' ')
  return `set --; for p in ${list}; do [ -e "$p" ] && set -- "$@" "$p"; done; tar cf - "$@"`
}

/** `adb shell` takes one string for the device's shell; `run-as` runs it as the app. */
const asApp = (pkg: string, script: string): string => `run-as ${shQuote(pkg)} sh -c ${shQuote(script)}`
const asShell = (script: string): string => `sh -c ${shQuote(script)}`

// ---- backend ----------------------------------------------------------------------------------

export interface Backend {
  via: 'run-as' | 'root'
  /** An emulator can come back under another serial after `adb root`. */
  serial: string
}

export const canRunAs = async (env: DeviceEnv, serial: string, pkg: string): Promise<boolean> =>
  (await quietCapture([adb(env), '-s', serial, 'shell', 'run-as', pkg, 'true'])).code === 0

async function avdName(env: DeviceEnv, serial: string): Promise<string | undefined> {
  if (!serial.startsWith('emulator-')) return undefined
  const { code, stdout } = await quietCapture([adb(env), '-s', serial, 'emu', 'avd', 'name'])
  return code === 0 ? stdout.split('\n')[0]?.trim() || undefined : undefined
}

/**
 * `run-as` when the build is debuggable (the usual path: Play images refuse `adb root`), else a
 * rooted adbd, else nothing. Rooting restarts adbd, so the device is found again before it is used.
 */
export async function pickBackend(env: DeviceEnv, serial: string, pkg: string): Promise<Backend | undefined> {
  if (await canRunAs(env, serial, pkg)) return { via: 'run-as', serial }
  const bin = adb(env)
  const avd = await avdName(env, serial)
  if ((await quietCapture([bin, '-s', serial, 'root'])).code !== 0) return undefined
  for (let i = 0; i < 10; i++) {
    const found = avd
      ? await emulatorSerial(env, avd)
      : (await listAndroidDevices(env)).some((d) => d.id === serial)
        ? serial
        : undefined
    if (found !== undefined) {
      await quietCapture([bin, '-s', found, 'wait-for-device'])
      const id = await quietCapture([bin, '-s', found, 'shell', 'id', '-u'])
      if (id.stdout.trim() === '0') return { via: 'root', serial: found }
    }
    await Bun.sleep(500)
  }
  return undefined
}

const noBackend = (): KitError =>
  new KitError(
    'The installed build is not debuggable and adb is not root',
    'kit app install android',
    ExitCode.precondition,
  )

async function adbOk(env: DeviceEnv, serial: string, args: string[], what: string): Promise<void> {
  const { code, stderr, stdout } = await runPiped([adb(env), '-s', serial, ...args])
  if (code !== 0) throw new KitError(`${what} failed: ${(stderr || stdout).trim()}`)
}

async function requireInstalled(env: DeviceEnv, serial: string, pkg: string): Promise<void> {
  const { code, stdout } = await quietCapture([adb(env), '-s', serial, 'shell', 'pm', 'path', pkg])
  if (code !== 0 || stdout.trim() === '') {
    throw new KitError(
      `${pkg} is not installed on ${serial}`,
      'kit app install android',
      ExitCode.precondition,
    )
  }
}

// ---- load -------------------------------------------------------------------------------------

export async function loadAndroid(
  env: DeviceEnv,
  device: string,
  name: string,
  cfg: FixtureConfig,
  source: string,
): Promise<FixtureResult> {
  const pkg = androidApp(env.config).packageName
  const bin = adb(env)
  await requireInstalled(env, device, pkg)

  if (env.flags.dryRun) {
    const ops = loadOps(cfg, 'android', (e) => hasEntry(source, e))
    const via = (await canRunAs(env, device, pkg)) ? 'run-as' : 'root'
    return { fixture: name, device, via, files: writtenPaths(ops), plan: describeOps(ops) }
  }

  const backend = await pickBackend(env, device, pkg)
  if (backend === undefined) throw noBackend()
  const serial = backend.serial
  env.log.step(`stopping ${pkg}`)
  await quietCapture([bin, '-s', serial, 'shell', 'am', 'force-stop', pkg])

  const staged = stageFixture(source)
  const tmp = deviceTmpDir(pkg)
  try {
    await runPrepare(cfg, staged.dir, { name, platform: 'android', root: env.root })
    const ops = loadOps(cfg, 'android', (e) => hasEntry(staged.dir, e))
    const copies = ops.filter((o): o is Extract<LoadOp, { op: 'copy' }> => o.op === 'copy')

    const dirs = copies.map((c) => (c.dir ? c.from : posix.dirname(c.from))).filter((d) => d !== '.')
    const setup = [
      'rm -rf --',
      shQuote(tmp),
      '&& mkdir -p --',
      shQuote(tmp),
      ...dirs.map((d) => shQuote(`${tmp}/${d}`)),
    ]
    await adbOk(env, serial, ['shell', setup.join(' ')], 'preparing the device temp dir')
    for (const c of copies) {
      const local = join(staged.dir, c.from)
      // `dir/.` pushes the contents into the existing device dir instead of nesting the dir.
      await adbOk(
        env,
        serial,
        ['push', c.dir ? `${local}/.` : local, `${tmp}/${c.from}`],
        `pushing ${c.from}`,
      )
    }
    await adbOk(env, serial, ['shell', `chmod -R 777 ${shQuote(tmp)}`], 'opening the device temp dir')

    const data = `/data/data/${pkg}`
    const script = androidLoadScript({ ops, tmp, data, root: backend.via === 'root' })
    env.log.step(`copying into ${pkg} (via ${backend.via})`)
    await adbOk(
      env,
      serial,
      ['shell', backend.via === 'run-as' ? asApp(pkg, script) : asShell(script)],
      'the copy',
    )
    return { fixture: name, device: serial, via: backend.via, files: writtenPaths(ops) }
  } finally {
    staged.dispose()
    await quietCapture([bin, '-s', serial, 'shell', `rm -rf ${shQuote(tmp)}`])
  }
}

// ---- dump -------------------------------------------------------------------------------------

export async function dumpAndroid(
  env: DeviceEnv,
  device: string,
  name: string,
  cfg: FixtureConfig,
): Promise<FixtureResult> {
  const pkg = androidApp(env.config).packageName
  const entries = entriesFor(cfg, 'android')
  if (!(await canRunAs(env, device, pkg))) {
    throw new KitError(
      'Dumping needs run-as, and the installed build is not debuggable',
      'kit app install android',
      ExitCode.precondition,
    )
  }
  const paths = entries.flatMap((e) => {
    const dest = destOf(e, 'android')
    return e.sqlite && !e.isDir ? [dest, `${dest}-wal`, `${dest}-shm`] : [dest]
  })
  if (env.flags.dryRun) {
    return { fixture: name, device, via: 'run-as', ...dumpPlan(cfg, 'android', name) }
  }

  env.log.step(`stopping ${pkg}`)
  await quietCapture([adb(env), '-s', device, 'shell', 'am', 'force-stop', pkg])
  const work = mkdtempSync(join(tmpdir(), 'kit-fixture-dump-'))
  const off = onCleanup(() => rmSync(work, { recursive: true, force: true }))
  try {
    // The app's own uid streams its files out as a tar: nothing else on a phone can reach them.
    const proc = Bun.spawn([adb(env), '-s', device, 'exec-out', asApp(pkg, androidDumpScript(paths))], {
      env: childEnv(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [tar, err] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (tar.byteLength === 0) {
      throw new KitError(
        `Nothing came back from ${device}${code !== 0 ? `: ${err.trim()}` : ''}`,
        'Launch the app once first',
        ExitCode.precondition,
      )
    }
    // A capture cut short still unpacks; replacing the fixture with half of one is worse than failing.
    if (code !== 0)
      throw new KitError(`The capture from ${device} failed (exit ${code})`, err.trim() || undefined)
    const x = Bun.spawn(['tar', 'xf', '-', '-C', work], {
      stdin: new Blob([tar]),
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const [xerr, xcode] = await Promise.all([new Response(x.stderr).text(), x.exited])
    if (xcode !== 0) throw new KitError(`Could not unpack the capture: ${xerr.trim()}`)
    const files = commitCapture(cfg, 'android', name, work)
    return { fixture: name, device, via: 'run-as', files }
  } finally {
    rmSync(work, { recursive: true, force: true })
    off()
  }
}
