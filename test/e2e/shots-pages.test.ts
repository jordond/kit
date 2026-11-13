import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findChrome } from '../../src/lib/chrome'
import { imageInfo } from '../../src/lib/image/png'
import type { ServedRequest } from '../../src/lib/storeshots/pages'
import { type FakeChrome, type FakeChromeMode, fakeChrome } from '../helpers/fake-chrome'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit shots pages` against a copy of the shots-app fixture; a fake Chrome stands in through `KIT_CHROME`. */

let f: Fixture
let chrome: FakeChrome
afterEach(() => f?.cleanup())

function setup() {
  f = fixture('shots-app', [])
  chrome = fakeChrome(f.dir)
}

const run = (args: string[] = [], mode?: FakeChromeMode, env: Record<string, string> = {}) =>
  f.kit(['shots', 'pages', ...args], {
    env: { KIT_CHROME: chrome.bin, CHROME_PATH: '', FAKE_CHROME: mode ?? '', ...env },
  })

const path = (rel: string) => join(f.dir, rel)
const info = (rel: string) => imageInfo(new Uint8Array(readFileSync(path(rel))))

describe('kit shots pages', () => {
  test('renders every page at its size, scale and path, one Chrome run each', async () => {
    setup()
    const r = await run(['--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      dryRun: false,
      pages: [
        { name: 'header', file: 'build/shots-pages/header-1920x800.png', width: 1920, height: 800 },
        { name: 'search', file: 'build/art/search.png', width: 1200, height: 800 },
      ],
    })
    expect(info('build/shots-pages/header-1920x800.png')).toMatchObject({
      width: 1920,
      height: 800,
      alpha: false,
    })
    expect(info('build/art/search.png')).toMatchObject({ width: 1200, height: 800, alpha: false })

    const calls = chrome.calls()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('--force-device-scale-factor=2')
    expect(calls[0]).toContain('--window-size=960,400')
    expect(calls[0]).toContain('--virtual-time-budget=5000')
    expect(calls[1]).toContain('--force-device-scale-factor=1')
    expect(calls[1]).toContain('--window-size=1200,800')
    // The URL, with its path token, is in the opener file, not on argv.
    expect(calls[0]!.at(-1)).toMatch(/^file:\/\/.+\/open\.html$/)
    expect(chrome.runs()[0]!.url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/brand\/pages\/header\.html$/,
    )
  })

  test('names pick pages in the order given; --out redirects the files', async () => {
    setup()
    const r = await run(['search', 'header', '--out', 'build/art2'])
    expect(r.code).toBe(0)
    expect(existsSync(path('build/art2/search.png'))).toBe(true)
    expect(existsSync(path('build/art2/header-1920x800.png'))).toBe(true)
    expect(existsSync(path('build/shots-pages'))).toBe(false)
    expect(r.stderr).toContain('2 pages written')
  })

  test('--dry-run lists the files and starts no Chrome', async () => {
    setup()
    const r = await run(['header', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).dryRun).toBe(true)
    expect(chrome.calls()).toEqual([])
    expect(existsSync(path('build'))).toBe(false)
  })

  test('an unknown page name is a usage error', async () => {
    setup()
    const r = await run(['nope'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('No page named "nope"')
    expect(r.stderr).toContain('header, search')
  })

  test('an empty --out is a usage error', async () => {
    setup()
    const r = await run(['--out', ''])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--out has an empty value')
  })

  test('a wrong-size PNG fails naming the page and writes nothing', async () => {
    setup()
    const r = await run([], 'wrong-size')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('The PNG for page header is 1921x800')
    expect(existsSync(path('build'))).toBe(false)
  })

  test('Chrome writing no screenshot fails naming the page', async () => {
    setup()
    const r = await run(['header'], 'missing')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Chrome wrote no screenshot of page header')
  })

  test('a Chrome that exits without a shot reports its exit code', async () => {
    setup()
    const r = await run(['header'], 'exit')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('(exit code 3)')
    expect(r.stderr).toContain('fake chrome crashed')
  })

  test('a Chrome that hangs is killed at the timeout', async () => {
    setup()
    const { renderPages, planPages } = await import('../../src/lib/storeshots/pages')
    const config = (await import(path('kit.config.ts'))).default
    const jobs = planPages(f.dir, config.shots, ['header'], undefined)
    process.env.FAKE_CHROME = 'hang'
    try {
      await expect(
        renderPages(jobs, { chrome: chrome.bin, root: f.dir, shots: config.shots, timeoutMs: 300 }),
      ).rejects.toThrow('Chrome did not finish page header within 300ms')
    } finally {
      delete process.env.FAKE_CHROME
    }
  })

  test('alpha is flattened onto the page background', async () => {
    setup()
    const r = await run(['header'], 'rgba')
    expect(r.code).toBe(0)
    expect(info('build/shots-pages/header-1920x800.png').alpha).toBe(false)
  })

  test('a missing HTML file is a config error', async () => {
    setup()
    writeFileSync(
      path('kit.config.ts'),
      readFileSync(path('kit.config.ts'), 'utf8').replace('header.html', 'gone.html'),
    )
    const r = await run(['header'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('no HTML file')
    expect(chrome.calls()).toEqual([])
  })

  test('a page file under a dot dir is a config error, not a PNG of "Not found"', async () => {
    setup()
    mkdirSync(path('.art'))
    copyFileSync(path('brand/pages/header.html'), path('.art/h.html'))
    writeFileSync(
      path('kit.config.ts'),
      readFileSync(path('kit.config.ts'), 'utf8').replace('brand/pages/header.html', '.art/h.html'),
    )
    for (const extra of [[], ['--dry-run']]) {
      const r = await run(['header', ...extra])
      expect(r.code).toBe(3)
      expect(r.stderr).toContain('dot path')
    }
    expect(chrome.calls()).toEqual([])
  })

  test('a page whose asset is refused or missing fails naming the page and the path', async () => {
    setup()
    writeFileSync(path('brand/pages/header.html'), '<!doctype html><img src="missing.png"><h1>x</h1>')
    const r = await run(['header'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(
      'Page header requested /brand/pages/missing.png, which the server answered 404',
    )
    expect(existsSync(path('build'))).toBe(false)
  })

  test('works with pages and no project; export then says shots.project is not set', async () => {
    setup()
    const config = readFileSync(path('kit.config.ts'), 'utf8').replace("project: 'brand/studio.json',", '')
    writeFileSync(path('kit.config.ts'), config)
    expect((await run(['header'])).code).toBe(0)
    const r = await f.kit(['shots', 'export'], { env: { KIT_CHROME: chrome.bin } })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('shots.project is not set')
  })

  test('a config with a page whose size is not a multiple of its scale is refused', async () => {
    setup()
    writeFileSync(
      path('kit.config.ts'),
      readFileSync(path('kit.config.ts'), 'utf8').replace('width: 1920', 'width: 1919'),
    )
    const r = await run(['header'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('not a multiple of the scale 2')
  })

  test('kit doctor checks Chrome when only shots.pages is set', async () => {
    setup()
    const config = readFileSync(path('kit.config.ts'), 'utf8').replace("project: 'brand/studio.json',", '')
    writeFileSync(path('kit.config.ts'), config)
    const r = await f.kit(['doctor'], { env: { KIT_CHROME: chrome.bin } })
    expect(r.stdout + r.stderr).toContain('chrome')
  })
})

/** One render with a real Chrome: `KIT_CHROME_TEST=1 bun test test/e2e/shots-pages.test.ts`. */
describe.skipIf(process.env.KIT_CHROME_TEST !== '1')('kit shots pages with a real Chrome', () => {
  test('renders the fixture pages at the exact size, without alpha, with the font and asset loaded', async () => {
    const bin = findChrome()
    if (bin === undefined) throw new Error('KIT_CHROME_TEST=1 needs Chrome: install it or set KIT_CHROME')
    f = fixture('shots-app', [])
    const r = await f.kit(['shots', 'pages', '--json'], { env: { KIT_CHROME: bin } })
    expect(r.stderr).not.toContain('✖')
    expect(r.code).toBe(0)
    expect(info('build/shots-pages/header-1920x800.png')).toMatchObject({
      format: 'png',
      width: 1920,
      height: 800,
      alpha: false,
    })
    expect(info('build/art/search.png')).toMatchObject({ width: 1200, height: 800, alpha: false })
  }, 120_000)

  test('Chrome requests the page, its asset and the declared font, all answered 200', async () => {
    const bin = findChrome()
    if (bin === undefined) throw new Error('KIT_CHROME_TEST=1 needs Chrome: install it or set KIT_CHROME')
    f = fixture('shots-app', [])
    const { planPages, renderPages } = await import('../../src/lib/storeshots/pages')
    const { shots } = (await import(path('kit.config.ts'))).default
    const requests: ServedRequest[] = []
    await renderPages(planPages(f.dir, shots, ['header'], undefined), {
      chrome: bin,
      root: f.dir,
      shots,
      requests,
    })
    expect(requests).toContainEqual({ path: 'brand/pages/header.html', status: 200 })
    expect(requests).toContainEqual({ path: 'brand/mark.svg', status: 200 })
    expect(requests).toContainEqual({ path: 'brand/fonts/fixture.ttf', status: 200 })
    expect(requests.every((r) => r.status === 200)).toBe(true)
  }, 120_000)
})
