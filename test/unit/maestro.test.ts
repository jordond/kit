import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KitConfig } from '../../src/config/schema'
import { log } from '../../src/lib/log'
import { maestroEnv } from '../../src/lib/maestro/bin'
import {
  collectScreenshots,
  copyScreenshots,
  failureSummary,
  flowCommand,
  junitPaths,
  listRunDirs,
  newRunDirs,
  runSuite,
} from '../../src/lib/maestro/run'
import { outputDir, resolveSuite } from '../../src/lib/maestro/suites'

type Suites = NonNullable<NonNullable<KitConfig['maestro']>['suites']>
const cfg = (suites?: Suites): KitConfig =>
  ({ name: 'x', targets: {}, maestro: { dir: 'm', suites } }) as KitConfig

describe('resolveSuite', () => {
  test('defaults exist without config', () => {
    expect(resolveSuite(cfg(), 'qa')).toMatchObject({ stages: [['smoke']], statusBar: false, env: {} })
    expect(resolveSuite(cfg(), 'shots')).toMatchObject({
      stages: [['screenshots']],
      statusBar: true,
      screenshots: join('m', 'screenshots'),
    })
  })

  test('extends chain: parent first, own fields win, env merges', () => {
    const suites: Suites = {
      base: { tags: ['a'], env: { A: '1', B: '1' }, fixture: 'f' },
      mid: { extends: 'base', env: { B: '2' } },
      leaf: { extends: 'mid', statusBar: true },
    }
    expect(resolveSuite(cfg(suites), 'leaf')).toMatchObject({
      stages: [['a']],
      fixture: 'f',
      statusBar: true,
      env: { A: '1', B: '2' },
    })
  })

  test('stages and tags replace each other', () => {
    const suites: Suites = {
      p: { tags: ['one'] },
      c: { extends: 'p', stages: [['x'], ['y']] },
      d: { extends: 'c', tags: ['z'] },
    }
    expect(resolveSuite(cfg(suites), 'c').stages).toEqual([['x'], ['y']])
    expect(resolveSuite(cfg(suites), 'd').stages).toEqual([['z']])
  })

  test('a configured suite named like a default starts from it', () => {
    expect(resolveSuite(cfg({ shots: { env: { K: 'v' } } }), 'shots')).toMatchObject({
      stages: [['screenshots']],
      statusBar: true,
      env: { K: 'v' },
    })
  })

  test('a loop is a config error', () => {
    const suites: Suites = { a: { extends: 'b' }, b: { extends: 'a' } }
    expect(() => resolveSuite(cfg(suites), 'a')).toThrow(/loop/)
  })

  test('unknown suite lists the known ones', () => {
    expect(() => resolveSuite(cfg(), 'nope')).toThrow(/No maestro suite "nope"/)
  })

  test('fixture: false drops an inherited fixture', () => {
    const suites: Suites = { p: { tags: ['t'], fixture: 'f' }, c: { extends: 'p', fixture: false } }
    expect(resolveSuite(cfg(suites), 'c').fixture).toBeUndefined()
  })
})

describe('flowCommand', () => {
  test('always passes --device, never --flatten-debug-output', () => {
    expect(
      flowCommand('maestro', {
        dir: 'm',
        device: 'emu-1',
        tags: ['a', 'b'],
        outputDir: 'm/output/android-qa',
        env: { PLATFORM: 'android', K: 'v' },
      }),
    ).toEqual([
      'maestro',
      '--device',
      'emu-1',
      'test',
      'm',
      '--include-tags',
      'a,b',
      '--test-output-dir',
      'm/output/android-qa',
      '-e',
      'PLATFORM=android',
      '-e',
      'K=v',
    ])
  })

  test('junit adds the report format and path', () => {
    const cmd = flowCommand('maestro', {
      dir: 'm',
      device: 'd',
      tags: ['t'],
      outputDir: 'o',
      junit: 'r/qa.xml',
    })
    expect(cmd.slice(-4)).toEqual(['--format', 'JUNIT', '--output', 'r/qa.xml'])
  })

  test('output dir is per suite and target', () => {
    expect(outputDir(cfg(), 'qa', 'ios')).toBe(join('m', 'output', 'ios-qa'))
  })
})

describe('maestroEnv', () => {
  test('no analytics or update check; a longer driver start only in CI', () => {
    const saved = process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT
    delete process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT
    try {
      expect(maestroEnv({ ci: false })).toEqual({
        MAESTRO_CLI_NO_ANALYTICS: '1',
        MAESTRO_DISABLE_UPDATE_CHECK: 'true',
      })
      expect(maestroEnv({ ci: true }).MAESTRO_DRIVER_STARTUP_TIMEOUT).toBe('240000')
      process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT = '5'
      expect(maestroEnv({ ci: true }).MAESTRO_DRIVER_STARTUP_TIMEOUT).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT
      else process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT = saved
    }
  })
})

describe('junitPaths', () => {
  test('one stage keeps the name; more add -2, -3 before the extension', () => {
    expect(junitPaths('out/qa.xml', 1)).toEqual(['out/qa.xml'])
    expect(junitPaths('out/qa.xml', 3)).toEqual(['out/qa.xml', 'out/qa-2.xml', 'out/qa-3.xml'])
    expect(junitPaths('qa', 2)).toEqual(['qa', 'qa-2.xml'])
  })
})

describe('run dirs and screenshots', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const tmp = () => {
    dir = mkdtempSync(join(tmpdir(), 'kit-maestro-'))
    return dir
  }
  const shot = (root: string, run: string, flow: string, name: string, body = name) => {
    const d = join(root, run, flow, 'takeScreenshot')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, name), body)
  }

  test('a missing output dir lists nothing; the diff is what the stage added, not the newest', () => {
    const root = tmp()
    expect(listRunDirs(join(root, 'nope'))).toEqual([])
    shot(root, '2026-01-02_000000', 'f', 'a.png')
    const before = listRunDirs(root)
    // An older-named dir appearing later (another run's clock) is still what this stage wrote.
    shot(root, '2026-01-01_000000', 'f', 'b.png')
    expect(newRunDirs(before, listRunDirs(root))).toEqual(['2026-01-01_000000'])
  })

  test('collects PNGs from every flow of the new runs only', () => {
    const root = tmp()
    shot(root, 'r1', 'old', 'old.png')
    shot(root, 'r2', 'f1', 'home.png')
    shot(root, 'r2', 'f2', 'detail.png')
    writeFileSync(join(root, 'r2', 'f2', 'notes.txt'), 'x')
    const names = collectScreenshots(root, ['r2']).map((s) => s.name)
    expect(names).toEqual(['home.png', 'detail.png'])
  })

  test('a shot replaces the file of the same name and leaves the rest', () => {
    const root = tmp()
    const dest = join(root, 'dest')
    mkdirSync(dest)
    writeFileSync(join(dest, 'keep.png'), 'keep')
    writeFileSync(join(dest, 'home.png'), 'old')
    shot(root, 'r', 'f', 'home.png', 'new')
    copyScreenshots(collectScreenshots(root, ['r']), dest)
    expect(readFileSync(join(dest, 'home.png'), 'utf8')).toBe('new')
    expect(readFileSync(join(dest, 'keep.png'), 'utf8')).toBe('keep')
  })
})

describe('runSuite order', () => {
  test('dry run plans build, install, status bar, fixture, then the stages, and runs nothing', async () => {
    const config = {
      name: 'x',
      targets: {},
      app: { ios: { bundleId: 'p', project: 'ios/App.xcodeproj', scheme: 'App' } },
      maestro: { dir: 'm' },
    } as unknown as KitConfig
    const loaded: string[] = []
    const env = {
      root: tmpdir(),
      config,
      flags: {
        dryRun: true,
        json: false,
        yes: true,
        verbose: false,
        quiet: false,
        bail: false,
        interactive: false,
        ci: true,
      },
      log,
    }
    const suite = { ...resolveSuite(config, 'shots'), fixture: 'demo' }
    const { result, plan } = await runSuite(env, 'ios', {
      suite,
      device: '<device>',
      noBuild: false,
      loadFixture: async (_e, _t, _d, name) => {
        loaded.push(name)
        throw new Error('must not load in a dry run')
      },
    })
    expect(loaded).toEqual([])
    expect(result.stages).toEqual([])
    const at = (re: RegExp) => plan.findIndex((c) => re.test(c.join(' ')))
    expect(at(/^xcodebuild/)).toBeGreaterThanOrEqual(0)
    expect(at(/^xcodebuild/)).toBeLessThan(at(/simctl install/))
    expect(at(/simctl install/)).toBeLessThan(at(/status_bar/))
    expect(at(/status_bar/)).toBeLessThan(at(/^kit fixture load/))
    expect(plan.at(-2)).toEqual(['kit', 'fixture', 'load', 'ios', 'demo', '--device', '<device>'])
    expect(plan.at(-1)?.[3]).toBe('test')
    expect(existsSync(join(tmpdir(), 'm', 'output'))).toBe(false)
  })

  test('failureSummary names the failed tags and the exit code', () => {
    const stage = { tags: ['smoke'], ok: false, code: 1, ms: 1, outputDir: 'o', screenshots: [] }
    expect(failureSummary({ suite: 'qa', target: 'ios', device: 'd', ok: false, stages: [stage] })).toBe(
      'smoke failed on ios (maestro exit 1)',
    )
  })
})

describe('review regressions', () => {
  test('a suite that extends shots inherits its screenshots dir; an unrelated shots-* name gets none', () => {
    const suites: Suites = { store: { extends: 'shots', tags: ['store'] }, 'shots-debug': { tags: ['d'] } }
    expect(resolveSuite(cfg(suites), 'store').screenshots).toBe(join('m', 'screenshots'))
    expect(resolveSuite(cfg(suites), 'shots-debug').screenshots).toBeUndefined()
  })

  test('flowFiles: a maestro.dir that does not exist has no flows', async () => {
    const { flowFiles } = await import('../../src/lib/maestro/lint')
    expect(flowFiles(mkdtempSync(join(tmpdir(), 'kit-noflows-')), cfg())).toEqual([])
  })

  test('`maestro` is a target name for lint only', async () => {
    const { selectTargets } = await import('../../src/lib/targets')
    expect(() => selectTargets(cfg(), ['maestro'])).toThrow(/Unknown target/)
    expect(selectTargets(cfg(), ['maestro'], true).targets).toEqual([])
  })
})
