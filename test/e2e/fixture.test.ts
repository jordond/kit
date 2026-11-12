import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit fixture load|dump`: fake adb / xcrun record every call; the data container is a temp dir. */

const SIM = 'SIM-UDID-1'
const PIXEL = 'emulator-5554 device product:sdk model:Pixel_8 device:emu'
const TMP = '/data/local/tmp/kit-fixture-app.example'

let f: Fixture
const scratch: string[] = []
afterEach(() => {
  f?.cleanup()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-fx-'))
  scratch.push(dir)
  return dir
}

const env = (extra: Record<string, string> = {}) => ({
  KIT_TEST_LOG: join(f.dir, '.t.log'),
  KIT_ADB_DEVICES: PIXEL,
  ...extra,
})
const raw = (): string =>
  existsSync(join(f.dir, '.t.log')) ? readFileSync(join(f.dir, '.t.log'), 'utf8') : ''
/** The log with the shell quoting of the script argument undone, so its lines read as written. */
const log = (): string => raw().replaceAll("'\\''", "'")
const at = (path: string): string => join(f.dir, path)

function setup(): void {
  f = fixture('fixtures-app', ['adb', 'xcrun'])
  // KIT_RUNAS=0 refuses run-as; KIT_ROOT_OK=1 lets `adb root` work; after it the emulator is on
  // KIT_ADB_DEVICES_AFTER. KIT_NO_PKG=1 means the app is not installed. KIT_TAR is what exec-out prints.
  f.script(
    'adb',
    `echo "adb $*" >> "$KIT_TEST_LOG"
if [ "$1" = -s ]; then serial="$2"; shift 2; fi
show() { printf 'List of devices attached\\n'; printf "$1\\n"; }
case "$*" in
  "devices -l") if [ -f "$KIT_TEST_LOG.rooted" ] && [ -n "$KIT_ADB_DEVICES_AFTER" ]; then show "$KIT_ADB_DEVICES_AFTER"; else show "$KIT_ADB_DEVICES"; fi ;;
  "emu avd name") printf 'Pixel_8\\nOK\\n' ;;
  "shell pm path"*) [ "$KIT_NO_PKG" = 1 ] && exit 1; echo "package:/data/app/base.apk" ;;
  "shell run-as app.example true") [ "$KIT_RUNAS" = 0 ] && exit 1; exit 0 ;;
  "root") if [ "$KIT_ROOT_OK" = 1 ]; then touch "$KIT_TEST_LOG.rooted"; echo restarting; exit 0; fi; echo "adbd cannot run as root in production builds"; exit 1 ;;
  "shell id -u") if [ -f "$KIT_TEST_LOG.rooted" ]; then echo 0; else echo 2000; fi ;;
  push*) [ -f "$2" ] && cp "$2" "$KIT_TEST_LOG.pushed.$(basename "$2")" ;;
  exec-out*) cat "$KIT_TAR" ;;
esac
exit 0`,
  )
  f.script(
    'xcrun',
    `echo "xcrun $*" >> "$KIT_TEST_LOG"
case "$*" in
  "simctl list devices -j") echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-1":[{"udid":"${SIM}","name":"iPhone 17","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"x"}]}}' ;;
  "simctl get_app_container"*) [ -n "$KIT_DATA_DIR" ] && echo "$KIT_DATA_DIR" || exit 1 ;;
esac
exit 0`,
  )
}

describe('kit fixture load (android)', () => {
  test('replays through run-as: pushes the staged files, then copies inside the data dir', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'android'], { env: env() })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Loaded sample onto emulator-5554 (via run-as)')
    const l = log()
    expect(l).toContain('adb -s emulator-5554 shell am force-stop app.example')
    expect(l).toMatch(new RegExp(`push \\S*/app\\.db ${TMP}/app\\.db`))
    expect(l).toMatch(new RegExp(`push \\S*/photos/\\. ${TMP}/photos`))
    expect(l).toContain('shell chmod -R 777')
    expect(l).toContain("run-as 'app.example' sh -c")
    expect(l).toContain("rm -rf -- 'databases/app.db'")
    expect(l).toContain("rm -rf -- 'databases/app.db-wal'")
    expect(l).toContain(`cp -- '${TMP}/app.db' 'databases/app.db'`)
    expect(l).toContain(`cp -R -- '${TMP}/photos/.' 'files/photos/'`)
    expect(l).toContain("rm -rf -- 'cache'")
    expect(l).not.toContain('chown')
    expect(l.trimEnd().split('\n').at(-1)).toContain(`rm -rf '${TMP}'`)
    // The prepare hook ran on the staged copy, with its env, before the push.
    expect(readFileSync(at('.prepare.log'), 'utf8')).toBe('sample android kit-fixture- cwd-ok\n')
    expect(readFileSync(`${env().KIT_TEST_LOG}.pushed.settings.json`, 'utf8')).toContain('patched')
    // The repo's fixture is untouched by the hook.
    expect(readFileSync(at('fx/sample/settings.json'), 'utf8')).not.toContain('patched')
  })

  test('falls back to root, and follows the emulator to its new serial', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'android'], {
      env: env({
        KIT_RUNAS: '0',
        KIT_ROOT_OK: '1',
        KIT_ADB_DEVICES_AFTER: 'emulator-5556 device product:sdk model:Pixel_8 device:emu',
      }),
    })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('(via root)')
    const l = log()
    expect(l).toContain('adb -s emulator-5554 root')
    expect(l).toContain('adb -s emulator-5556 shell id -u')
    expect(l).toMatch(new RegExp(`adb -s emulator-5556 push \\S*/app\\.db ${TMP}/app\\.db`))
    expect(l).toContain("cd '/data/data/app.example'")
    expect(l).toContain(`chown -R "$(stat -c '%u:%g' '/data/data/app.example')" '/data/data/app.example'`)
    expect(l).toContain("restorecon -R '/data/data/app.example'")
    expect(l).not.toContain("run-as 'app.example'")
  })

  test('neither run-as nor root is a precondition failure that pushes nothing', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'android'], { env: env({ KIT_RUNAS: '0' }) })
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('not debuggable and adb is not root')
    expect(r.stderr).toContain('kit app install android')
    expect(log()).not.toContain(' push ')
    expect(log()).not.toContain('force-stop')
  })

  test('the app not being installed exits 4 with the install hint', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'android'], { env: env({ KIT_NO_PKG: '1' }) })
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('kit app install android')
  })

  test('no running device exits 4', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'android'], { env: env({ KIT_ADB_DEVICES: '' }) })
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('kit device boot android')
  })

  test('an unknown fixture exits 2 and lists the ones there are', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'android', 'nope'], { env: env() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Available: sample')
  })

  test('--dry-run --json plans the copy and touches nothing', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'android', '--dry-run', '--json'], { env: env() })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.target).toBe('android')
    expect(doc.device).toBe('emulator-5554')
    expect(doc.fixture).toBe('sample')
    expect(doc.files).toEqual(['databases/app.db', 'files/settings.json', 'files/photos/'])
    expect(doc.plan).toContain('remove databases/app.db-shm')
    expect(doc.plan).toContain('copy photos/ -> files/photos')
    expect(doc.plan).toContain('remove cache')
    expect(log()).not.toMatch(/push|force-stop|run-as 'app|rm -rf/)
    expect(existsSync(at('.prepare.log'))).toBe(false)
  })

  test('--json after a real load is the result plus the target', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'android', 'sample', '--json'], { env: env() })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({
      target: 'android',
      fixture: 'sample',
      device: 'emulator-5554',
      via: 'run-as',
    })
  })
})

/** A tar of an app data dir as `run-as … tar` would print it, with a real SQLite db still in WAL mode. */
function deviceTar(opts: { withDb?: boolean } = {}): string {
  const src = temp()
  mkdirSync(join(src, 'databases'))
  mkdirSync(join(src, 'files/photos'), { recursive: true })
  writeFileSync(join(src, 'files/settings.json'), '{"first_launch":2}\n')
  writeFileSync(join(src, 'files/photos/new.jpg'), 'jpg-new')
  const paths = ['./files/settings.json', './files/photos']
  if (opts.withDb !== false) {
    const db = new Database(join(src, 'databases/app.db'))
    db.run('PRAGMA journal_mode=WAL')
    db.run('CREATE TABLE t (n INTEGER)')
    db.run('INSERT INTO t VALUES (42)')
    for (const ext of ['', '-wal', '-shm']) {
      if (existsSync(join(src, `databases/app.db${ext}`))) {
        Bun.spawnSync(['cp', join(src, `databases/app.db${ext}`), join(src, `databases/copy.db${ext}`)])
      }
    }
    db.close()
    for (const ext of ['', '-wal', '-shm']) {
      Bun.spawnSync(['mv', join(src, `databases/copy.db${ext}`), join(src, `databases/app.db${ext}`)])
    }
    paths.unshift('./databases/app.db', './databases/app.db-wal', './databases/app.db-shm')
  }
  const tar = join(temp(), 'out.tar')
  const made = Bun.spawnSync(['tar', 'cf', tar, '-C', src, ...paths.filter((p) => existsSync(join(src, p)))])
  expect(made.exitCode).toBe(0)
  return tar
}

describe('kit fixture dump (android)', () => {
  test('extracts the tar, checkpoints the WAL, normalises modes and replaces the fixture', async () => {
    setup()
    writeFileSync(at('fx/sample/stale.txt'), 'old')
    const r = await f.kit(['fixture', 'dump', 'android', 'sample'], { env: env({ KIT_TAR: deviceTar() }) })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Dumped sample from emulator-5554 (via run-as)')
    expect(log()).toContain('exec-out')
    expect(log()).toContain("run-as 'app.example' sh -c")
    expect(log()).toContain("'./databases/app.db-wal'")
    expect(existsSync(at('fx/sample/stale.txt'))).toBe(false)
    expect(existsSync(at('fx/sample/app.db-wal'))).toBe(false)
    expect(existsSync(at('fx/sample/app.db-shm'))).toBe(false)
    const db = new Database(at('fx/sample/app.db'))
    expect(db.query('SELECT n FROM t').all()).toEqual([{ n: 42 }])
    db.close()
    expect(readFileSync(at('fx/sample/settings.json'), 'utf8')).toContain('"first_launch":2')
    expect(readFileSync(at('fx/sample/photos/new.jpg'), 'utf8')).toBe('jpg-new')
    expect(existsSync(at('fx/sample/photos/a.jpg'))).toBe(false)
    expect(statSync(at('fx/sample/app.db')).mode & 0o777).toBe(0o644)
    expect(statSync(at('fx/sample/photos')).mode & 0o777).toBe(0o755)
    expect(readFileSync(at('fx/sample/app.db')).subarray(0, 6).toString()).toBe('SQLite')
  })

  test('without the database it fails and replaces nothing', async () => {
    setup()
    const r = await f.kit(['fixture', 'dump', 'android', 'sample'], {
      env: env({ KIT_TAR: deviceTar({ withDb: false }) }),
    })
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('Launch the app once first')
    expect(readFileSync(at('fx/sample/app.db'), 'utf8')).toBe('not really sqlite')
    expect(existsSync(at('fx/sample/photos/a.jpg'))).toBe(true)
  })

  test('needs run-as', async () => {
    setup()
    const r = await f.kit(['fixture', 'dump', 'android', 'sample'], { env: env({ KIT_RUNAS: '0' }) })
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('run-as')
    expect(log()).not.toContain('exec-out')
  })

  test('--dry-run --json writes nothing', async () => {
    setup()
    const r = await f.kit(['fixture', 'dump', 'android', 'fresh', '--dry-run', '--json'], { env: env() })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.files).toEqual(['fx/fresh/app.db', 'fx/fresh/settings.json', 'fx/fresh/photos'])
    expect(doc.plan[0]).toBe('pull databases/app.db -> fx/fresh/app.db')
    expect(existsSync(at('fx/fresh'))).toBe(false)
    expect(log()).not.toContain('exec-out')
  })

  test('needs a name', async () => {
    setup()
    expect((await f.kit(['fixture', 'dump', 'android'], { env: env() })).code).toBe(2)
  })
})

describe.if(process.platform === 'darwin')('kit fixture (ios simulator)', () => {
  /** A data container shaped like the real one, which the path guard insists on. */
  const container = (): string => {
    const dir = join(temp(), `CoreSimulator/Devices/${SIM}/data/Containers/Data/Application/APP-ID-1`)
    mkdirSync(join(dir, 'Documents/databases'), { recursive: true })
    mkdirSync(join(dir, 'Documents/photos'), { recursive: true })
    mkdirSync(join(dir, 'Library/Caches'), { recursive: true })
    writeFileSync(join(dir, 'Documents/databases/app.db'), 'old db')
    writeFileSync(join(dir, 'Documents/databases/app.db-wal'), 'stale wal')
    writeFileSync(join(dir, 'Documents/photos/old.jpg'), 'old')
    writeFileSync(join(dir, 'Library/Caches/x'), 'cache')
    writeFileSync(join(dir, 'Documents/keep.txt'), 'untouched')
    return dir
  }

  test('load replaces the files in the container and clears the caches', async () => {
    setup()
    const dir = container()
    const r = await f.kit(['fixture', 'load', 'ios'], { env: env({ KIT_DATA_DIR: dir }) })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`Loaded sample onto ${SIM} (via simctl)`)
    expect(log()).toContain(`xcrun simctl terminate ${SIM} app.example`)
    expect(readFileSync(join(dir, 'Documents/databases/app.db'), 'utf8')).toBe('not really sqlite')
    expect(existsSync(join(dir, 'Documents/databases/app.db-wal'))).toBe(false)
    expect(existsSync(join(dir, 'Documents/photos/old.jpg'))).toBe(false)
    expect(readFileSync(join(dir, 'Documents/photos/a.jpg'), 'utf8')).toBe('jpg-a')
    expect(readFileSync(join(dir, 'Documents/settings.json'), 'utf8')).toContain('patched')
    expect(existsSync(join(dir, 'Library/Caches'))).toBe(false)
    expect(readFileSync(join(dir, 'Documents/keep.txt'), 'utf8')).toBe('untouched')
  })

  test('dump copies from the container into the fixture', async () => {
    setup()
    const dir = container()
    rmSync(join(dir, 'Documents/databases/app.db'))
    const db = new Database(join(dir, 'Documents/databases/app.db'))
    db.run('CREATE TABLE t (n INTEGER)')
    db.run('INSERT INTO t VALUES (7)')
    db.close()
    rmSync(join(dir, 'Documents/databases/app.db-wal'), { force: true })
    writeFileSync(join(dir, 'Documents/settings.json'), '{"first_launch":3}\n')
    const r = await f.kit(['fixture', 'dump', 'ios', 'sample'], { env: env({ KIT_DATA_DIR: dir }) })
    expect(r.code).toBe(0)
    const out = new Database(at('fx/sample/app.db'))
    expect(out.query('SELECT n FROM t').all()).toEqual([{ n: 7 }])
    out.close()
    expect(readFileSync(at('fx/sample/settings.json'), 'utf8')).toContain('"first_launch":3')
    expect(readFileSync(at('fx/sample/photos/old.jpg'), 'utf8')).toBe('old')
    expect(existsSync(at('fx/sample/photos/a.jpg'))).toBe(false)
  })

  test('a container path outside CoreSimulator is refused and nothing is deleted', async () => {
    setup()
    const outside = temp()
    mkdirSync(join(outside, 'Documents/databases'), { recursive: true })
    writeFileSync(join(outside, 'Documents/databases/app.db'), 'precious')
    const r = await f.kit(['fixture', 'load', 'ios'], { env: env({ KIT_DATA_DIR: outside }) })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Refusing to touch')
    expect(readFileSync(join(outside, 'Documents/databases/app.db'), 'utf8')).toBe('precious')
  })

  test('the app not being installed exits 4', async () => {
    setup()
    const r = await f.kit(['fixture', 'load', 'ios'], { env: env() })
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('kit app install ios')
  })
})
