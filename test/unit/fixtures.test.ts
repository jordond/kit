import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KitConfig } from '../../src/config/schema'
import { notASimulator } from '../../src/lib/fixtures'
import { androidDumpScript, androidLoadScript, shQuote } from '../../src/lib/fixtures/android'
import {
  cleanRelPath,
  describeOps,
  fixtureConfig,
  listFixtures,
  loadOps,
  resolveFixtureName,
} from '../../src/lib/fixtures/config'
import { containerRoot } from '../../src/lib/fixtures/ios'
import {
  assembleCapture,
  checkpointDatabase,
  commitCapture,
  hasEntry,
  normalizeModes,
  runPrepare,
  stageFixture,
} from '../../src/lib/fixtures/stage'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'kit-fxu-'))
  dirs.push(d)
  return d
}

const cfgOf = (fixtures: Record<string, unknown>): KitConfig =>
  ({ name: 'x', fixtures }) as unknown as KitConfig
const FILES = [
  { from: 'app.db', ios: 'Documents/databases', android: 'databases', sqlite: true },
  { from: 'settings.json', ios: 'Documents', android: 'files' },
  { from: 'photos/', ios: 'Documents/photos', android: 'files/photos' },
  { from: 'extra.json', android: 'files' },
]
const base = (root: string, extra: Record<string, unknown> = {}) =>
  fixtureConfig(root, cfgOf({ dir: 'fx', files: FILES, ...extra }))

describe('path validation', () => {
  test('rejects absolute paths and .. anywhere, with exit 3', () => {
    for (const bad of ['/etc', '../x', 'a/../../x', 'a/..', '~/x', 'C:\\x', '', 'a\\b']) {
      expect(() => cleanRelPath(bad, 'from')).toThrow()
    }
    const root = temp()
    const attempts: Record<string, unknown>[] = [
      { files: [{ from: '/abs', android: 'x' }] },
      { files: [{ from: 'a', android: '../x' }] },
      { files: [{ from: 'a', ios: '/x' }] },
      { files: FILES, clear: { android: ['../cache'] } },
      { files: FILES, clear: { ios: ['/tmp'] } },
      { files: FILES, prepare: '../evil' },
      { dir: '../out', files: FILES },
    ]
    for (const a of attempts) {
      try {
        fixtureConfig(root, cfgOf({ dir: 'fx', ...a }))
        throw new Error('accepted')
      } catch (e) {
        expect((e as { exitCode?: number }).exitCode).toBe(3)
      }
    }
  })

  test('normalises ./ and trailing slashes and keeps dirs apart from files', () => {
    expect(cleanRelPath('./databases/', 'x')).toBe('databases')
    const cfg = base(temp())
    expect(cfg.files.map((f) => [f.from, f.isDir])).toEqual([
      ['app.db', false],
      ['settings.json', false],
      ['photos', true],
      ['extra.json', false],
    ])
  })

  test('a dir may not target the whole data dir, and clear may not name it', () => {
    expect(() => fixtureConfig(temp(), cfgOf({ dir: 'fx', files: [{ from: 'p/', android: '.' }] }))).toThrow()
    expect(() => base(temp(), { clear: { ios: ['.'] } })).toThrow()
  })

  test('a missing fixtures block is a config error with a minimal block as the hint', () => {
    try {
      fixtureConfig(temp(), { name: 'x' } as unknown as KitConfig)
      throw new Error('accepted')
    } catch (e) {
      const err = e as { exitCode: number; hint: string }
      expect(err.exitCode).toBe(3)
      expect(err.hint).toContain('fixtures: { dir:')
    }
  })
})

describe('the load plan', () => {
  const cfg = base('/repo', { clear: { android: ['cache'], ios: ['Library/Caches'] } })

  test('removes each destination first, also when the fixture lacks it', () => {
    const ops = loadOps(cfg, 'android', (e) => e.from === 'app.db')
    expect(describeOps(ops)).toEqual([
      'remove databases/app.db',
      'remove databases/app.db-wal',
      'remove databases/app.db-shm',
      'copy app.db -> databases/app.db',
      'remove files/settings.json',
      'remove files/photos',
      'remove files/extra.json',
      'remove cache',
    ])
  })

  test('skips entries with no destination on the platform', () => {
    const ops = loadOps(cfg, 'ios', () => true)
    expect(describeOps(ops).some((l) => l.includes('extra.json'))).toBe(false)
    expect(describeOps(ops)).toContain('copy photos/ -> Documents/photos')
    expect(describeOps(ops).at(-1)).toBe('remove Library/Caches')
  })
})

describe('androidLoadScript', () => {
  const ops = loadOps(base('/repo', { clear: { android: ['cache'] } }), 'android', () => true)
  const TMP = '/data/local/tmp/kit-fixture-app.x'

  test('run-as variant works in the data dir and never chowns', () => {
    const s = androidLoadScript({ ops, tmp: TMP, data: '/data/data/app.x', root: false })
    expect(s.startsWith('set -e\nrm -rf -- ')).toBe(true)
    expect(s).toContain(`cp -- '${TMP}/app.db' 'databases/app.db'`)
    expect(s).toContain(`cp -R -- '${TMP}/photos/.' 'files/photos/'`)
    expect(s).toContain("rm -rf -- 'cache'")
    expect(s).not.toContain('chown')
    expect(s).not.toContain('cd ')
  })

  test('root variant cds into the data dir, restores owner and SELinux labels', () => {
    const s = androidLoadScript({ ops, tmp: TMP, data: '/data/data/app.x', root: true })
    expect(s).toContain("cd '/data/data/app.x'")
    expect(s).toContain(`chown -R "$(stat -c '%u:%g' '/data/data/app.x')" '/data/data/app.x'`)
    expect(s).toContain("restorecon -R '/data/data/app.x'")
    expect(s.indexOf('chown')).toBeGreaterThan(s.lastIndexOf('cp '))
  })

  test('shQuote survives quotes, spaces and expansions', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(shQuote('$(id) `id`')).toBe("'$(id) `id`'")
  })

  test('config values cannot inject shell: the script runs hostile paths as plain names', () => {
    const work = temp()
    const evil = `a'; touch ${join(work, 'pwned')}; echo '`
    const cfg = fixtureConfig(
      work,
      cfgOf({
        dir: 'fx',
        files: [{ from: 'f.txt', android: `d $(touch ${join(work, 'pwned2')})` }],
        clear: { android: [evil] },
      }),
    )
    const tmp = join(work, 'tmp')
    mkdirSync(tmp)
    writeFileSync(join(tmp, 'f.txt'), 'hello')
    const data = join(work, 'data')
    mkdirSync(data)
    const script = androidLoadScript({
      ops: loadOps(cfg, 'android', () => true),
      tmp,
      data,
      root: false,
    })
    const r = Bun.spawnSync(['sh', '-c', script], { cwd: data })
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(work, 'pwned'))).toBe(false)
    expect(existsSync(join(work, 'pwned2'))).toBe(false)
    expect(readFileSync(join(data, `d $(touch ${join(work, 'pwned2')})`, 'f.txt'), 'utf8')).toBe('hello')
  })

  test('the dump script tars what exists and quotes every path', () => {
    const work = temp()
    mkdirSync(join(work, 'databases'))
    writeFileSync(join(work, 'databases/app.db'), 'x')
    writeFileSync(join(work, "we'ird"), 'y')
    const script = androidDumpScript(['databases/app.db', 'databases/app.db-wal', "we'ird"])
    const r = Bun.spawnSync(['sh', '-c', script], { cwd: work })
    expect(r.exitCode).toBe(0)
    const listing = Bun.spawnSync(['tar', 'tf', '-'], { stdin: r.stdout })
    expect(listing.stdout.toString().split('\n').filter(Boolean).sort()).toEqual([
      './databases/app.db',
      "./we'ird",
    ])
  })
})

describe('staging and the prepare hook', () => {
  function repo(): { root: string; source: string } {
    const root = temp()
    const source = join(root, 'fx/sample')
    mkdirSync(source, { recursive: true })
    const db = new Database(join(source, 'app.db'))
    db.run('CREATE TABLE t (d INTEGER)')
    db.run('INSERT INTO t VALUES (1)')
    db.close()
    return { root, source }
  }

  test('the staged copy is a copy: edits to it never reach the fixture, and dispose removes it', () => {
    const { source } = repo()
    const staged = stageFixture(source)
    writeFileSync(join(staged.dir, 'new.txt'), 'x')
    expect(existsSync(join(source, 'new.txt'))).toBe(false)
    expect(existsSync(join(staged.dir, 'app.db'))).toBe(true)
    staged.dispose()
    expect(existsSync(staged.dir)).toBe(false)
  })

  test('the hook sees the env, runs in the staged dir and can edit the staged db', async () => {
    const { root, source } = repo()
    writeFileSync(
      join(root, 'prepare'),
      `#!/bin/sh
printf '%s|%s|%s|%s|%s' "$KIT_FIXTURE" "$KIT_PLATFORM" "$KIT_ROOT" "$KIT_FIXTURE_DIR" "$(pwd -P)" > "$KIT_ROOT/seen"
bun -e 'import { Database } from "bun:sqlite"; const d = new Database("app.db"); d.run("UPDATE t SET d = d + 100"); d.close()'
`,
    )
    chmodSync(join(root, 'prepare'), 0o755)
    const cfg = base(root, { prepare: 'prepare' })
    const staged = stageFixture(source)
    await runPrepare(cfg, staged.dir, { name: 'sample', platform: 'ios', root })
    const [name, platform, kitRoot, fixtureDir, cwd] = readFileSync(join(root, 'seen'), 'utf8').split('|')
    expect([name, platform, kitRoot, fixtureDir]).toEqual(['sample', 'ios', root, staged.dir])
    expect(realpathSync(cwd!)).toBe(realpathSync(staged.dir))
    const db = new Database(join(staged.dir, 'app.db'))
    expect(db.query('SELECT d FROM t').all()).toEqual([{ d: 101 }])
    db.close()
    const orig = new Database(join(source, 'app.db'))
    expect(orig.query('SELECT d FROM t').all()).toEqual([{ d: 1 }])
    orig.close()
    staged.dispose()
  })

  test('a failing hook fails the load; a non-executable one is a config error', async () => {
    const { root, source } = repo()
    writeFileSync(join(root, 'prepare'), '#!/bin/sh\nexit 7\n')
    const cfg = base(root, { prepare: 'prepare' })
    const staged = stageFixture(source)
    await expect(runPrepare(cfg, staged.dir, { name: 's', platform: 'android', root })).rejects.toMatchObject(
      {
        exitCode: 3,
      },
    )
    chmodSync(join(root, 'prepare'), 0o755)
    await expect(runPrepare(cfg, staged.dir, { name: 's', platform: 'android', root })).rejects.toThrow(
      'exited with 7',
    )
    staged.dispose()
  })

  test('hasEntry tells a file from a dir', () => {
    const { source } = repo()
    mkdirSync(join(source, 'photos'))
    const cfg = base('/repo')
    const [db, , photos] = cfg.files
    expect(hasEntry(source, db!)).toBe(true)
    expect(hasEntry(source, photos!)).toBe(true)
    expect(hasEntry(source, cfg.files[1]!)).toBe(false)
  })
})

describe('dump side', () => {
  test('checkpointDatabase folds a real WAL into the file and drops the sidecars', () => {
    const work = temp()
    const live = join(work, 'live.db')
    const db = new Database(live)
    db.run('PRAGMA journal_mode=WAL')
    db.run('PRAGMA wal_autocheckpoint=0')
    db.run('CREATE TABLE t (n INTEGER)')
    db.run('INSERT INTO t VALUES (5)')
    // Snapshot while the writer still holds the WAL: what a stopped app leaves on a phone.
    const snap = join(work, 'snap.db')
    for (const ext of ['', '-wal', '-shm']) {
      if (existsSync(live + ext)) Bun.spawnSync(['cp', live + ext, snap + ext])
    }
    db.close()
    expect(existsSync(`${snap}-wal`)).toBe(true)
    // Without the WAL the table would not exist at all: the main file is still empty.
    checkpointDatabase(snap)
    expect(existsSync(`${snap}-wal`)).toBe(false)
    expect(existsSync(`${snap}-shm`)).toBe(false)
    const out = new Database(snap)
    expect(out.query('SELECT n FROM t').all()).toEqual([{ n: 5 }])
    out.close()
  })

  test('assembleCapture maps the app layout back to fixture layout and skips what is absent', () => {
    const work = temp()
    const cfg = base(work)
    const data = join(work, 'data')
    mkdirSync(join(data, 'databases'), { recursive: true })
    mkdirSync(join(data, 'files/photos'), { recursive: true })
    writeFileSync(join(data, 'databases/app.db'), 'db')
    writeFileSync(join(data, 'files/photos/a.jpg'), 'a')
    const out = join(work, 'out')
    mkdirSync(out)
    // Not a sqlite file and no WAL: copied as is.
    expect(assembleCapture(data, cfg, 'android', out)).toEqual(['app.db', 'photos'])
    expect(existsSync(join(out, 'settings.json'))).toBe(false)
    expect(readFileSync(join(out, 'photos/a.jpg'), 'utf8')).toBe('a')
  })

  test('commitCapture refuses a capture without the first entry and leaves the fixture alone', () => {
    const work = temp()
    const cfg = base(work)
    mkdirSync(join(work, 'fx/sample'), { recursive: true })
    writeFileSync(join(work, 'fx/sample/app.db'), 'keep')
    const data = join(work, 'data')
    mkdirSync(join(data, 'files'), { recursive: true })
    writeFileSync(join(data, 'files/settings.json'), '{}')
    expect(() => commitCapture(cfg, 'android', 'sample', data)).toThrow('nothing was replaced')
    try {
      commitCapture(cfg, 'android', 'sample', data)
    } catch (e) {
      expect((e as { hint: string }).hint).toBe('Launch the app once first')
    }
    expect(readFileSync(join(work, 'fx/sample/app.db'), 'utf8')).toBe('keep')
    expect(listFixtures(cfg)).toEqual(['sample'])
    expect(existsSync(join(work, 'fx/sample/settings.json'))).toBe(false)
  })

  test('a dump keeps the entries that have no destination on its platform', () => {
    const work = temp()
    const cfg = base(work)
    mkdirSync(join(work, 'fx/sample'), { recursive: true })
    writeFileSync(join(work, 'fx/sample/extra.json'), 'android only')
    writeFileSync(join(work, 'fx/sample/app.db'), 'old')
    const data = join(work, 'data')
    mkdirSync(join(data, 'Documents/databases'), { recursive: true })
    writeFileSync(join(data, 'Documents/databases/app.db'), 'new')
    expect(commitCapture(cfg, 'ios', 'sample', data)).toEqual(['fx/sample/app.db'])
    expect(readFileSync(join(work, 'fx/sample/app.db'), 'utf8')).toBe('new')
    expect(readFileSync(join(work, 'fx/sample/extra.json'), 'utf8')).toBe('android only')
  })

  test('normalizeModes sets files 0644 and dirs 0755', () => {
    const work = temp()
    mkdirSync(join(work, 'd'))
    writeFileSync(join(work, 'd/f'), 'x')
    chmodSync(join(work, 'd/f'), 0o777)
    chmodSync(join(work, 'd'), 0o700)
    normalizeModes(work)
    expect(statSync(join(work, 'd/f')).mode & 0o777).toBe(0o644)
    expect(statSync(join(work, 'd')).mode & 0o777).toBe(0o755)
  })
})

describe('names', () => {
  function withFixtures(...names: string[]) {
    const root = temp()
    mkdirSync(join(root, 'fx'))
    for (const n of names) mkdirSync(join(root, 'fx', n), { recursive: true })
    writeFileSync(join(root, 'fx/README.md'), 'not a fixture')
    mkdirSync(join(root, 'fx/.hidden'))
    return base(root)
  }

  test('the only fixture is the default', () => {
    expect(resolveFixtureName(withFixtures('sample'), undefined)).toBe('sample')
  })

  test('none or several is a usage error that says what to do', () => {
    expect(() => resolveFixtureName(withFixtures(), undefined)).toThrow('No fixtures in fx')
    try {
      resolveFixtureName(withFixtures('a', 'b'), undefined)
      throw new Error('accepted')
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(2)
      expect((e as { hint: string }).hint).toBe('Available: a, b')
    }
  })

  test('a name is passed through but may not be a path', () => {
    const cfg = withFixtures('a', 'b')
    expect(resolveFixtureName(cfg, 'b')).toBe('b')
    for (const bad of ['../x', 'a/b', '.hidden', '']) expect(() => resolveFixtureName(cfg, bad)).toThrow()
  })
})

describe('the simulator container guard', () => {
  test("accepts only this simulator's app data container", () => {
    const root = temp()
    const ok = join(root, 'CoreSimulator/Devices/UDID-1/data/Containers/Data/Application/ID-9')
    mkdirSync(ok, { recursive: true })
    expect(containerRoot(ok, 'UDID-1')).toContain('/CoreSimulator/Devices/UDID-1/')
    expect(() => containerRoot(ok, 'UDID-2')).toThrow('Refusing')
    expect(() => containerRoot(root, 'UDID-1')).toThrow('Refusing')
    const bundle = join(root, 'CoreSimulator/Devices/UDID-1/data/Containers/Bundle/Application/ID-9')
    mkdirSync(bundle, { recursive: true })
    expect(() => containerRoot(bundle, 'UDID-1')).toThrow('Refusing')
  })
})

describe('a device that is not a simulator UDID', () => {
  const sims = [{ udid: 'AAAA-1', name: 'iPhone 17 Pro' }]

  test("a simulator's name gets the UDID to pass", () => {
    const error = notASimulator('iPhone 17 Pro', sims)
    expect(error.message).toBe("iPhone 17 Pro is a simulator's name; fixtures need its UDID")
    expect(error.hint).toBe('--device AAAA-1')
  })

  test('an unknown id is reported as not found, not as a physical device', () => {
    const error = notASimulator('no-such-device', sims)
    expect(error.message).toBe('No simulator has the UDID no-such-device')
    expect(error.hint).toContain('kit device list')
  })
})
