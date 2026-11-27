import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findChrome } from '../../src/lib/chrome'
import { imageInfo } from '../../src/lib/image/png'
import type { ExportResult } from '../../src/lib/storeshots/types'
import { type FakeChrome, type FakeChromeMode, fakeChrome } from '../helpers/fake-chrome'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit shots export` with `shots.slides`: the shots-app fixture with HTML slides in place of its project. */

let f: Fixture
let chrome: FakeChrome
afterEach(() => f?.cleanup())

interface SlideConfig {
  name: string
  file?: string
  shot?: string
  background?: string
}

const SLIDES: SlideConfig[] = [
  { name: 'home', shot: 'home', background: '#ffd400' },
  { name: 'journal', shot: 'journal.png' },
]

/** Rewrite the fixture's config: `shots.slides` (every slide the same HTML file) instead of `shots.project`. */
function useSlides(slides: SlideConfig[] = SLIDES, extra = '') {
  const file = join(f.dir, 'kit.config.ts')
  const entries = slides.map((s) => JSON.stringify({ file: 'brand/store/slide.html', ...s })).join(', ')
  const config = readFileSync(file, 'utf8').replace(
    "project: 'brand/studio.json',",
    `slides: [${entries}],${extra}`,
  )
  if (!config.includes('slides: [')) throw new Error('the fixture config has no shots.project line')
  writeFileSync(file, config)
}

function setup(slides?: SlideConfig[], extra?: string) {
  f = fixture('shots-app', [])
  chrome = fakeChrome(f.dir)
  useSlides(slides, extra)
}

const run = (args: string[] = [], mode?: FakeChromeMode, env: Record<string, string> = {}) =>
  f.kit(['shots', 'export', ...args], {
    env: { KIT_CHROME: chrome.bin, CHROME_PATH: '', FAKE_CHROME: mode ?? '', ...env },
  })

const APPLE = 'fastlane/screenshots'
const GOOGLE = 'fastlane/metadata/android'
const PHONE = 'images/phoneScreenshots'
const path = (rel: string) => join(f.dir, rel)
const ls = (rel: string): string[] =>
  existsSync(path(rel))
    ? readdirSync(path(rel))
        .filter((name) => !name.startsWith('.'))
        .sort()
    : []
const info = (rel: string) => imageInfo(new Uint8Array(readFileSync(path(rel))))
const json = (stdout: string) => JSON.parse(stdout) as ExportResult

describe('kit shots export with HTML slides', () => {
  test('renders every slide into the three listing sets, at the set size and a scale kit picks', async () => {
    setup()
    const r = await run(['--locale', 'en-US', '--json'])
    expect(r.stderr).not.toContain('viewport')
    expect(r.code).toBe(0)
    expect(ls(`${APPLE}/en-US`)).toEqual([
      '01_ipad-13_home.png',
      '01_iphone-6.9_home.png',
      '02_ipad-13_journal.png',
      '02_iphone-6.9_journal.png',
    ])
    expect(ls(`${GOOGLE}/en-US/${PHONE}`)).toEqual(['01_home.png', '02_journal.png'])
    expect(info(`${APPLE}/en-US/01_iphone-6.9_home.png`)).toMatchObject({
      width: 1320,
      height: 2868,
      alpha: false,
    })
    expect(info(`${APPLE}/en-US/01_ipad-13_home.png`)).toMatchObject({
      width: 2064,
      height: 2752,
      alpha: false,
    })
    expect(info(`${GOOGLE}/en-US/${PHONE}/01_home.png`)).toMatchObject({
      width: 1440,
      height: 2560,
      alpha: false,
    })

    const result = json(r.stdout)
    expect(result.written).toHaveLength(6)
    expect(result.written[0]).toEqual({
      store: 'apple',
      target: 'ios',
      set: 'iphone-6.9',
      locale: 'en-US',
      slide: 'home',
      file: `${APPLE}/en-US/01_iphone-6.9_home.png`,
      width: 1320,
      height: 2868,
    })

    // One Chrome run per image: never a viewport under 500 CSS px.
    const calls = chrome.calls()
    expect(calls).toHaveLength(6)
    const windows = calls.map((argv) =>
      argv.filter((a) => /^--(window-size|force-device-scale-factor)=/.test(a)).join(' '),
    )
    expect(windows).toEqual([
      '--force-device-scale-factor=2 --window-size=660,1434',
      '--force-device-scale-factor=2 --window-size=660,1434',
      '--force-device-scale-factor=4 --window-size=516,688',
      '--force-device-scale-factor=4 --window-size=516,688',
      '--force-device-scale-factor=2 --window-size=720,1280',
      '--force-device-scale-factor=2 --window-size=720,1280',
    ])
    // The page URL says which set, target and shot it is drawn for.
    const url = new URL(chrome.runs()[2]!.url!)
    expect(url.pathname).toMatch(/^\/[0-9a-f]{32}\/brand\/store\/slide\.html$/)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      set: 'ipad-13',
      target: 'ipad',
      store: 'apple',
      locale: 'en-US',
      slide: 'home',
      index: '1',
    })
    expect(url.searchParams.get('shot')).toMatch(/^\/[0-9a-f]{32}\/__kit\/shot\/\d+$/)
  })

  test('a removed slide takes its old file with it, and the later slides are renumbered', async () => {
    setup()
    expect((await run(['--locale', 'en-US'])).code).toBe(0)
    expect(ls(`${GOOGLE}/en-US/${PHONE}`)).toEqual(['01_home.png', '02_journal.png'])

    useSlidesAgain([{ name: 'journal', shot: 'journal' }])
    const r = await run(['--locale', 'en-US', '--json'])
    expect(r.code).toBe(0)
    expect(ls(`${APPLE}/en-US`)).toEqual(['01_ipad-13_journal.png', '01_iphone-6.9_journal.png'])
    expect(ls(`${GOOGLE}/en-US/${PHONE}`)).toEqual(['01_journal.png'])
    expect(json(r.stdout).removed).toEqual([
      `${GOOGLE}/en-US/${PHONE}/01_home.png`,
      `${GOOGLE}/en-US/${PHONE}/02_journal.png`,
      `${APPLE}/en-US/01_ipad-13_home.png`,
      `${APPLE}/en-US/01_iphone-6.9_home.png`,
      `${APPLE}/en-US/02_ipad-13_journal.png`,
      `${APPLE}/en-US/02_iphone-6.9_journal.png`,
    ])
    const manifest = JSON.parse(readFileSync(path(`${APPLE}/.kit-shots.json`), 'utf8'))
    expect(manifest.files).toEqual(['en-US/01_ipad-13_journal.png', 'en-US/01_iphone-6.9_journal.png'])
  })

  test('--store narrows the sets, and an image kit did not write is in the way', async () => {
    setup()
    mkdirSync(path(`${GOOGLE}/en-US/${PHONE}`), { recursive: true })
    writeFileSync(
      path(`${GOOGLE}/en-US/${PHONE}/mine.png`),
      readFileSync(path('maestro/screenshots/android/home.png')),
    )
    const blocked = await run(['--store', 'google', '--locale', 'en-US'])
    expect(blocked.code).toBe(4)
    expect(blocked.stderr).toContain('did not write')
    expect(chrome.calls()).toHaveLength(0)
    const forced = await run(['--store', 'google', '--locale', 'en-US', '--force'])
    expect(forced.code).toBe(0)
    expect(ls(`${GOOGLE}/en-US/${PHONE}`)).toEqual(['01_home.png', '02_journal.png'])
    expect(ls(`${APPLE}/en-US`)).toEqual([])
  })

  test('a missing raw shot stops the export; --allow-missing leaves that slide out', async () => {
    setup([...SLIDES, { name: 'extra', shot: 'nope' }])
    const r = await run(['--locale', 'en-US'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('maestro/screenshots/ios/nope.png')
    expect(chrome.calls()).toHaveLength(0)
    const allowed = await run(['--locale', 'en-US', '--allow-missing', '--out', 'build/out'])
    expect(allowed.code).toBe(0)
    expect(ls('build/out/google/en-US/images/phoneScreenshots')).toEqual(['01_home.png', '02_journal.png'])
  })

  test('a page laid out at another size than asked fails the render and writes nothing', async () => {
    setup()
    const r = await run(['--locale', 'en-US'], 'wrong-viewport')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Slide home (iphone-6.9, en-US) was laid out at 700x1434 CSS px, not 660x1434')
    expect(ls(`${APPLE}/en-US`)).toEqual([])
  })

  test('a slide that reports no viewport fails: it was not told its set either', async () => {
    setup([SLIDES[0]!])
    const r = await run(['--store', 'google', '--locale', 'en-US'], 'no-viewport')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Slide home (phone, en-US) did not report its viewport')
    expect(ls(`${GOOGLE}/en-US/${PHONE}`)).toEqual([])
  })

  test('--dry-run lists the files and starts no Chrome', async () => {
    setup()
    const r = await run(['--locale', 'en-US', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(json(r.stdout).written).toHaveLength(6)
    expect(chrome.calls()).toHaveLength(0)
    expect(ls(`${APPLE}/en-US`)).toEqual([])
  })

  test('shots.project beside shots.slides is a config error', async () => {
    setup(SLIDES, " project: 'brand/studio.json',")
    const r = await run(['--dry-run'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('shots.project and shots.slides are both set')
  })
})

/** Replace the slides of a config `useSlides` already rewrote. */
function useSlidesAgain(slides: SlideConfig[]) {
  const file = join(f.dir, 'kit.config.ts')
  const entries = slides.map((s) => JSON.stringify({ file: 'brand/store/slide.html', ...s })).join(', ')
  writeFileSync(file, readFileSync(file, 'utf8').replace(/slides: \[.*\],/, `slides: [${entries}],`))
}

/** One export with a real Chrome: `KIT_CHROME_TEST=1 bun test test/e2e/shots-slides.test.ts`. */
describe.skipIf(process.env.KIT_CHROME_TEST !== '1')('HTML slides with a real Chrome', () => {
  test('each set is laid out at the viewport asked for, and a second run writes the same bytes', async () => {
    const bin = findChrome()
    if (bin === undefined) throw new Error('KIT_CHROME_TEST=1 needs Chrome: install it or set KIT_CHROME')
    f = fixture('shots-app', [])
    chrome = fakeChrome(f.dir)
    useSlides([SLIDES[0]!])
    const real = (args: string[]) =>
      f.kit(['shots', 'export', ...args], { env: { KIT_CHROME: bin, CHROME_PATH: '' } })
    const first = await real(['--locale', 'en-US'])
    expect(first.stderr).not.toContain('viewport')
    expect(first.code).toBe(0)
    const files = [
      `${APPLE}/en-US/01_iphone-6.9_home.png`,
      `${APPLE}/en-US/01_ipad-13_home.png`,
      `${GOOGLE}/en-US/${PHONE}/01_home.png`,
    ]
    expect(files.map((file) => info(file))).toEqual([
      { format: 'png', width: 1320, height: 2868, alpha: false },
      { format: 'png', width: 2064, height: 2752, alpha: false },
      { format: 'png', width: 1440, height: 2560, alpha: false },
    ])
    const before = files.map((file) => Bun.hash(readFileSync(path(file))))
    // The iPad page takes its own background from data-kit-target, so it is not the iPhone's bytes scaled.
    expect(before[0]).not.toBe(before[1])
    expect((await real(['--locale', 'en-US'])).code).toBe(0)
    expect(files.map((file) => Bun.hash(readFileSync(path(file))))).toEqual(before)
  }, 120_000)
})
