import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { findChrome } from '../../src/lib/chrome'
import { encodePng, imageInfo } from '../../src/lib/image/png'
import type { ExportResult, StudioProject } from '../../src/lib/storeshots/types'
import { type FakeChrome, type FakeChromeMode, fakeChrome } from '../helpers/fake-chrome'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit shots export` against a copy of the shots-app fixture; a fake Chrome plays the page through `KIT_CHROME`. */

let f: Fixture
let chrome: FakeChrome
afterEach(() => f?.cleanup())

function setup(bins: string[] = []) {
  f = fixture('shots-app', bins)
  chrome = fakeChrome(f.dir)
}

const run = (args: string[] = [], mode?: FakeChromeMode, env: Record<string, string> = {}) =>
  f.kit(['shots', 'export', ...args], {
    env: { KIT_CHROME: chrome.bin, CHROME_PATH: '', FAKE_CHROME: mode ?? '', ...env },
  })

const APPLE = 'fastlane/screenshots'
const GOOGLE = 'fastlane/metadata/android'
const PHONE = 'images/phoneScreenshots'
const APPLE_FILES = [
  '01_ipad-13_1-home.png',
  '01_iphone-6.9_1-home.png',
  '02_ipad-13_2-journal.png',
  '02_iphone-6.9_2-journal.png',
]
const GOOGLE_FILES = ['01_1-home.png', '02_2-journal.png']

const path = (rel: string) => join(f.dir, rel)
/** File names in a fixture dir, sorted; dot files left out. */
const ls = (rel: string): string[] =>
  existsSync(path(rel))
    ? readdirSync(path(rel))
        .filter((name) => !name.startsWith('.'))
        .sort()
    : []
const info = (rel: string) => imageInfo(new Uint8Array(readFileSync(path(rel))))
const manifest = (dir: string) => JSON.parse(readFileSync(path(`${dir}/.kit-shots.json`), 'utf8'))
const json = (stdout: string) => JSON.parse(stdout) as ExportResult

/** Every PNG under the store dirs and `build/`, relative to the fixture. */
function pngs(): string[] {
  const out: string[] = []
  const visit = (rel: string) => {
    for (const name of readdirSync(path(rel))) {
      const at = `${rel}/${name}`
      if (statSync(path(at)).isDirectory()) visit(at)
      else if (name.endsWith('.png')) out.push(at)
    }
  }
  for (const root of ['fastlane', 'build']) if (existsSync(path(root))) visit(root)
  return out.sort()
}

function editProject(change: (project: StudioProject) => void) {
  const file = path('brand/studio.json')
  const project = JSON.parse(readFileSync(file, 'utf8')) as StudioProject
  change(project)
  writeFileSync(file, JSON.stringify(project, null, 2))
}

function editConfig(from: string | RegExp, to: string) {
  const file = path('kit.config.ts')
  const before = readFileSync(file, 'utf8')
  const after = before.replace(from, to)
  expect(after).not.toBe(before)
  writeFileSync(file, after)
}

function put(rel: string, bytes: Uint8Array | string) {
  mkdirSync(dirname(path(rel)), { recursive: true })
  writeFileSync(path(rel), bytes)
}

describe('kit shots export', () => {
  test('renders every slide for both stores and both locales, and writes the manifests', async () => {
    setup()
    const r = await run()
    expect(r.code).toBe(0)

    const calls = chrome.calls()
    expect(calls).toHaveLength(1)
    const argv = calls[0]!
    expect(argv.slice(0, 5)).toEqual([
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
    ])
    expect(argv[5]).toMatch(/^--user-data-dir=.+\/profile$/)
    expect(argv[6]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/$/)
    expect(argv).toHaveLength(7)

    // The iOS metadata dir also holds supply's `android/`: it is not a locale.
    expect(ls(APPLE)).toEqual(['en-US', 'fr-FR'])
    for (const locale of ['en-US', 'fr-FR']) {
      expect(ls(`${APPLE}/${locale}`)).toEqual(APPLE_FILES)
      expect(ls(`${GOOGLE}/${locale}/${PHONE}`)).toEqual(GOOGLE_FILES)
    }
    expect(info(`${APPLE}/en-US/01_iphone-6.9_1-home.png`)).toMatchObject({
      format: 'png',
      width: 1320,
      height: 2868,
      alpha: false,
    })
    expect(info(`${APPLE}/fr-FR/02_ipad-13_2-journal.png`)).toMatchObject({ width: 2064, height: 2752 })
    expect(info(`${GOOGLE}/fr-FR/${PHONE}/01_1-home.png`)).toMatchObject({ width: 1440, height: 2560 })

    expect(manifest(APPLE)).toEqual({
      version: 1,
      files: ['en-US', 'fr-FR'].flatMap((locale) => APPLE_FILES.map((name) => `${locale}/${name}`)),
    })
    expect(manifest(GOOGLE)).toEqual({
      version: 1,
      files: ['en-US', 'fr-FR'].flatMap((locale) => GOOGLE_FILES.map((name) => `${locale}/${PHONE}/${name}`)),
    })

    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('Rendering 12 screenshots in headless Chrome')
    expect(r.stderr).toContain('apple en-US: 2 x iphone-6.9 1320x2868, 2 x ipad-13 2064x2752')
    expect(r.stderr).toContain('google fr-FR: 2 x phone 1440x2560')
    expect(r.stderr).toContain('✔ 12 screenshots written')
  })

  test('--json prints the one document', async () => {
    setup()
    const r = await run(['--json'])
    expect(r.code).toBe(0)
    const doc = json(r.stdout)
    expect(Object.keys(doc)).toEqual(['dryRun', 'stores', 'written', 'removed', 'skipped'])
    expect(doc).toMatchObject({ dryRun: false, stores: ['apple', 'google'], removed: [], skipped: [] })
    expect(doc.written).toHaveLength(12)
    expect(doc.written[0]).toEqual({
      store: 'apple',
      target: 'ios',
      set: 'iphone-6.9',
      locale: 'en-US',
      slide: 'slide-1',
      file: `${APPLE}/en-US/01_iphone-6.9_1-home.png`,
      width: 1320,
      height: 2868,
    })
    expect(doc.written.at(-1)).toEqual({
      store: 'google',
      target: 'android',
      set: 'phone',
      locale: 'fr-FR',
      slide: 'slide-2',
      file: `${GOOGLE}/fr-FR/${PHONE}/02_2-journal.png`,
      width: 1440,
      height: 2560,
    })
    expect(doc.written.map((w) => w.file).sort()).toEqual(pngs())
  })

  test('--dry-run reports the plan, starts no Chrome and writes nothing', async () => {
    setup()
    // A dry run does not even look for Chrome.
    const r = await run(['--dry-run', '--json'], undefined, { KIT_CHROME: path('no-such-chrome') })
    expect(r.code).toBe(0)
    const doc = json(r.stdout)
    expect(doc).toMatchObject({ dryRun: true, stores: ['apple', 'google'], removed: [], skipped: [] })
    expect(doc.written).toHaveLength(12)
    expect(chrome.calls()).toEqual([])
    expect(pngs()).toEqual([])
    expect(existsSync(path(APPLE))).toBe(false)
    expect(existsSync(path(`${GOOGLE}/.kit-shots.json`))).toBe(false)

    const human = await run(['--dry-run'])
    expect(human.code).toBe(0)
    expect(human.stderr).toContain(`› ${APPLE}/en-US/01_iphone-6.9_1-home.png (1320x2868)`)
    expect(human.stderr).toContain('Dry run: 12 screenshots would be written')
    expect(chrome.calls()).toEqual([])
    expect(pngs()).toEqual([])
  })

  test('--store and --locale narrow the export', async () => {
    setup()
    const r = await run(['--store', 'apple', '--locale', 'fr-FR', '--json'])
    expect(r.code).toBe(0)
    expect(json(r.stdout).stores).toEqual(['apple'])
    expect(pngs()).toEqual(APPLE_FILES.map((name) => `${APPLE}/fr-FR/${name}`))
    expect(existsSync(path(`${GOOGLE}/.kit-shots.json`))).toBe(false)
  })

  test('a bad --store and a --locale no store has are usage errors', async () => {
    setup()
    const store = await run(['--store', 'amazon'])
    expect(store.code).toBe(2)
    expect(store.stderr).toContain('Unknown store "amazon"')
    const locale = await run(['--locale', 'de-DE'])
    expect(locale.code).toBe(2)
    expect(locale.stderr).toContain('No exported store has the locale de-DE')
    expect(locale.stderr).toContain('apple: en-US, fr-FR')
    expect(chrome.calls()).toEqual([])
  })

  test('--out writes <dir>/apple and <dir>/google and leaves the store dirs alone', async () => {
    setup()
    const r = await run(['--out', 'build/store-shots', '--locale', 'en-US', '--json'])
    expect(r.code).toBe(0)
    expect(pngs()).toEqual([
      ...APPLE_FILES.map((name) => `build/store-shots/apple/en-US/${name}`),
      ...GOOGLE_FILES.map((name) => `build/store-shots/google/en-US/${PHONE}/${name}`),
    ])
    expect(json(r.stdout).written[0]!.file).toBe('build/store-shots/apple/en-US/01_iphone-6.9_1-home.png')
    expect(manifest('build/store-shots/apple').files).toHaveLength(4)
    expect(manifest('build/store-shots/google').files).toHaveLength(2)
  })

  test('a store with no metadata dir has no destination (exit 2) unless --out is given', async () => {
    setup()
    editConfig(/\n {6}metadata: 'fastlane\/metadata',/, '')
    const r = await run()
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('No release.ios.metadata in kit.config.ts')
    expect(chrome.calls()).toEqual([])

    // With --out the store exports en-US, there being no listing dir to read locales from.
    const out = await run(['--store', 'apple', '--out', 'build/shots'])
    expect(out.code).toBe(0)
    expect(pngs()).toEqual(APPLE_FILES.map((name) => `build/shots/apple/en-US/${name}`))
  })

  test('no shots block is a config error (exit 3)', async () => {
    setup()
    editConfig(/ {2}shots: \{[\s\S]*?\n {2}\},\n/, '')
    const r = await run()
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('No shots block in kit.config.ts')
  })

  test('a PNG of the wrong size fails the run (exit 1) and nothing is written', async () => {
    setup()
    const r = await run([], 'wrong-size')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('The PNG for ios-en-US-01 is 1321x2868')
    expect(chrome.calls()).toHaveLength(1)
    expect(pngs()).toEqual([])
    expect(existsSync(path(`${APPLE}/.kit-shots.json`))).toBe(false)
  })

  test('RGBA output is flattened: no alpha reaches the disk', async () => {
    setup()
    const r = await run(['--store', 'google'], 'rgba')
    expect(r.code).toBe(0)
    const files = pngs()
    expect(files).toHaveLength(4)
    for (const file of files) {
      expect(info(file)).toMatchObject({ format: 'png', width: 1440, height: 2560, alpha: false })
    }
  })

  test('a missing or unrunnable Chrome is a precondition failure (exit 4) with the hint', async () => {
    setup()
    const missing = await run([], undefined, { KIT_CHROME: path('no-such-chrome') })
    expect(missing.code).toBe(4)
    expect(missing.stderr).toContain('is not a Chrome binary')
    expect(missing.stderr).toContain('Install Google Chrome, or set KIT_CHROME')

    put('not-chrome', 'not a binary')
    chmodSync(path('not-chrome'), 0o644)
    const unrunnable = await run([], undefined, { KIT_CHROME: path('not-chrome') })
    expect(unrunnable.code).toBe(4)
    expect(unrunnable.stderr).toContain('is not a Chrome binary kit can run')
    expect(unrunnable.stderr).toContain('Install Google Chrome, or set KIT_CHROME')
    expect(pngs()).toEqual([])
  })

  test('a missing raw shot is exit 4 naming it; --allow-missing skips the slide', async () => {
    setup()
    rmSync(path('maestro/screenshots/android/journal.png'))
    const r = await run()
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('1 raw shot is missing')
    expect(r.stderr).toContain('maestro/screenshots/android/journal.png')
    expect(chrome.calls()).toEqual([])
    expect(pngs()).toEqual([])

    const skip = await run(['--allow-missing', '--json'])
    expect(skip.code).toBe(0)
    const doc = json(skip.stdout)
    expect(doc.written).toHaveLength(10)
    expect(doc.skipped).toEqual(
      ['en-US', 'fr-FR'].map((locale) => ({
        store: 'google',
        target: 'android',
        set: 'phone',
        locale,
        slide: 'slide-2',
        shot: 'maestro/screenshots/android/journal.png',
      })),
    )
    expect(ls(`${GOOGLE}/en-US/${PHONE}`)).toEqual(['01_1-home.png'])
    expect(ls(`${APPLE}/en-US`)).toEqual(APPLE_FILES)
  })

  test('a missing font file is exit 4 before Chrome starts', async () => {
    setup()
    rmSync(path('brand/fonts/fixture.ttf'))
    const r = await run()
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('1 font or brand file is missing')
    expect(r.stderr).toContain('brand/fonts/fixture.ttf')
    expect(chrome.calls()).toEqual([])
  })

  test('an image kit did not write is in the way (exit 4); --force replaces it', async () => {
    setup()
    const theirs = `${GOOGLE}/en-US/${PHONE}/theirs.png`
    put(theirs, encodePng(2, 2, new Uint8Array(12)))
    // Play's other image types are never export's to touch.
    const icon = `${GOOGLE}/en-US/images/icon.png`
    put(icon, encodePng(2, 2, new Uint8Array(12)))

    const r = await run()
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('1 image kit shots export did not write is in the way')
    expect(r.stderr).toContain(theirs)
    expect(chrome.calls()).toEqual([])
    expect(pngs()).toEqual([icon, theirs].sort())

    const forced = await run(['--force', '--json'])
    expect(forced.code).toBe(0)
    expect(json(forced.stdout).removed).toEqual([theirs])
    expect(existsSync(path(theirs))).toBe(false)
    expect(existsSync(path(icon))).toBe(true)
    expect(ls(`${GOOGLE}/en-US/${PHONE}`)).toEqual(GOOGLE_FILES)
  })

  test('a font family that shots.fonts does not declare is exit 3 naming slide and family', async () => {
    setup()
    editProject((project) => {
      project.slides[1]!.headline.fontFamily = 'Nunito'
    })
    const r = await run()
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('1 font family is not declared in shots.fonts')
    expect(r.stderr).toContain('slide "2 - Journal" (slide-2) headline uses "Nunito"')
    expect(chrome.calls()).toEqual([])
    expect(pngs()).toEqual([])

    // A CSS generic needs no font file.
    editProject((project) => {
      project.slides[1]!.headline.fontFamily = 'sans-serif'
    })
    expect((await run(['--dry-run'])).code).toBe(0)
  })

  test('more slides than a store keeps per set is exit 4 at plan time', async () => {
    setup()
    editProject((project) => {
      const [first] = project.slides
      for (let i = 3; i <= 9; i++) {
        project.slides.push({ ...first!, id: `slide-${i}`, order: i, name: `${i} - More` })
      }
    })
    const r = await run(['--dry-run'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('phone: 9 slides, Play keeps at most 8 per set and locale')
    expect(r.stderr).not.toContain('iphone-6.9')
    // Nine is within Apple's ten.
    expect((await run(['--dry-run', '--store', 'apple'])).code).toBe(0)
  })

  test('a second export replaces its own files and removes the ones it no longer writes', async () => {
    setup()
    expect((await run(['--store', 'google'])).code).toBe(0)
    editProject((project) => {
      project.slides[1]!.name = '2 - Diary'
    })
    const r = await run(['--store', 'google', '--json'])
    expect(r.code).toBe(0)
    expect(json(r.stdout).removed).toEqual(
      ['en-US', 'fr-FR'].map((locale) => `${GOOGLE}/${locale}/${PHONE}/02_2-journal.png`),
    )
    for (const locale of ['en-US', 'fr-FR']) {
      expect(ls(`${GOOGLE}/${locale}/${PHONE}`)).toEqual(['01_1-home.png', '02_2-diary.png'])
    }
    expect(manifest(GOOGLE).files).toEqual(
      ['en-US', 'fr-FR'].flatMap((locale) =>
        ['01_1-home.png', '02_2-diary.png'].map((name) => `${locale}/${PHONE}/${name}`),
      ),
    )
  })

  test('`kit shots ios --dry-run` still plans the capture suite', async () => {
    setup(['xcrun', 'maestro'])
    const sims = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
          {
            udid: 'UDID-PHONE',
            name: 'iPhone 17',
            state: 'Booted',
            isAvailable: true,
            deviceTypeIdentifier: 'x',
          },
        ],
      },
    })
    f.script('xcrun', `case "$*" in "simctl list devices -j") echo '${sims}' ;; esac`)
    f.script('maestro', 'if [ "$1" = --version ]; then echo 2.9.0; fi; exit 0')
    const r = await f.kit(['shots', 'ios', '--no-fixture', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ suite: 'shots', target: 'ios' })
    expect(doc.plan.some((c: string[]) => c.join(' ').includes('--include-tags screenshots'))).toBe(true)
  })
})

/**
 * One render with a real Chrome: `KIT_CHROME_TEST=1 bun test test/e2e/shots-export.test.ts`.
 * The fixture font has glyphs for space and `A` only, so every other glyph falls back; the test is about
 * the page running, the fonts loading, and the size and colour type of what comes back.
 */
describe.skipIf(process.env.KIT_CHROME_TEST !== '1')('kit shots export with a real Chrome', () => {
  test('renders the fixture at the exact set sizes, without alpha', async () => {
    const bin = findChrome()
    if (bin === undefined) throw new Error('KIT_CHROME_TEST=1 needs Chrome: install it or set KIT_CHROME')
    f = fixture('shots-app', [])
    const r = await f.kit(['shots', 'export', '--locale', 'en-US', '--json'], { env: { KIT_CHROME: bin } })
    expect(r.stderr).not.toContain('✖')
    expect(r.code).toBe(0)
    const doc = json(r.stdout)
    expect(doc.written).toHaveLength(6)
    for (const shot of doc.written) {
      expect(info(shot.file)).toEqual({
        format: 'png',
        width: shot.width,
        height: shot.height,
        alpha: false,
      })
      // A composed slide is not a blank canvas: it compresses far worse than one.
      expect(readFileSync(path(shot.file)).length).toBeGreaterThan(20_000)
    }
    expect(info(`${APPLE}/en-US/01_iphone-6.9_1-home.png`)).toMatchObject({ width: 1320, height: 2868 })
    expect(info(`${APPLE}/en-US/01_ipad-13_1-home.png`)).toMatchObject({ width: 2064, height: 2752 })
    expect(info(`${GOOGLE}/en-US/${PHONE}/01_1-home.png`)).toMatchObject({ width: 1440, height: 2560 })
  }, 120_000)
})
