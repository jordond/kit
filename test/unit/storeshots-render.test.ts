import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ExitCode, KitError } from '../../src/lib/errors'
import { encodePng, imageInfo } from '../../src/lib/image/png'
import { renderJobs } from '../../src/lib/storeshots/render'
import { serveShots } from '../../src/lib/storeshots/server'
import { type ExportPlan, type Job, pagePlan, type Slide } from '../../src/lib/storeshots/types'
import { type FakeChromeMode, fakeChrome } from '../helpers/fake-chrome'

const dir = mkdtempSync(join(tmpdir(), 'kit-storeshots-render-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  delete process.env.FAKE_CHROME
})

const shot = join(dir, 'home.png')
writeFileSync(shot, encodePng(2, 2, new Uint8Array(12).fill(200)))
const font = join(dir, 'nunito.woff2')
writeFileSync(font, 'woff2 bytes')
const mark = join(dir, 'logo.svg')
writeFileSync(mark, '<svg xmlns="http://www.w3.org/2000/svg"/>')

function job(id: string, width: number, height: number): Job {
  return {
    id,
    store: 'apple',
    target: 'ios',
    set: 'iphone-6.9',
    locale: 'en-US',
    index: 1,
    width,
    height,
    slide: { id: `slide-${id}`, name: 'Home' } as Slide,
    shot,
    file: join(dir, 'out', `${id}.png`),
  }
}

const plan: ExportPlan = {
  stores: ['apple'],
  destinations: [{ store: 'apple', dir: join(dir, 'out'), locales: ['en-US'] }],
  jobs: [job('ios-en-US-01', 6, 8), job('ios-en-US-02', 4, 4)],
  skipped: [],
  fonts: [{ family: 'Nunito', url: 'asset/0' }],
  brand: { mark: 'asset/1' },
  assets: [font, mark],
}

const PAGE = 'console.log("page")'

/** Run `renderJobs` against a fresh fake Chrome in `mode`. */
async function render(mode?: FakeChromeMode, timeoutMs?: number) {
  const chrome = fakeChrome(mkdtempSync(join(dir, 'chrome-')))
  if (mode) process.env.FAKE_CHROME = mode
  const result = await renderJobs(plan, { chrome: chrome.bin, page: PAGE, timeoutMs }).then(
    (images) => ({ images, error: undefined }),
    (error: unknown) => ({ images: undefined, error }),
  )
  const argv = chrome.calls()[0] ?? []
  const profile = argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
  return { ...result, argv, profile }
}

function failure(error: unknown): KitError {
  expect(error).toBeInstanceOf(KitError)
  const e = error as KitError
  expect(e.exitCode).toBe(ExitCode.failed)
  return e
}

describe('renderJobs', () => {
  test('returns one PNG per job at the job size, from Chrome run on a throwaway profile', async () => {
    const { images, argv, profile } = await render()
    expect([...(images?.keys() ?? [])]).toEqual(['ios-en-US-01', 'ios-en-US-02'])
    expect(imageInfo(images!.get('ios-en-US-01')!)).toEqual({
      format: 'png',
      width: 6,
      height: 8,
      alpha: false,
    })
    expect(imageInfo(images!.get('ios-en-US-02')!)).toMatchObject({ width: 4, height: 4 })

    expect(argv.slice(0, 5)).toEqual([
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
    ])
    expect(argv).toHaveLength(7)
    expect(argv[5]).toBe(`--user-data-dir=${profile}`)
    expect(argv[6]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)

    // The profile is gone, and so is the server.
    expect(profile).toBeDefined()
    expect(existsSync(profile!)).toBe(false)
    expect(existsSync(dirname(profile!))).toBe(false)
    await expect(fetch(new URL('plan.json', argv[6]))).rejects.toThrow()
  })

  test('flattens a PNG with alpha', async () => {
    const { images } = await render('rgba')
    expect(imageInfo(images!.get('ios-en-US-01')!)).toEqual({
      format: 'png',
      width: 6,
      height: 8,
      alpha: false,
    })
  })

  test('a PNG of the wrong size is exit 1 and names the job', async () => {
    const { error, profile } = await render('wrong-size')
    const e = failure(error)
    expect(e.message).toBe('The PNG for ios-en-US-01 is 7x8')
    expect(e.hint).toContain('6x8')
    expect(existsSync(profile!)).toBe(false)
  })

  test('a job without a PNG is exit 1 and names the job', async () => {
    expect(failure((await render('missing')).error).message).toContain('ios-en-US-01')
  })

  test('a page error is exit 1 and carries the error', async () => {
    expect(failure((await render('error')).error).message).toContain('fake page error')
  })

  test('Chrome exiting before the page finished is exit 1 with the tail of its output', async () => {
    const { error, profile } = await render('exit')
    const e = failure(error)
    expect(e.message).toContain('Chrome exited (code 3)')
    expect(e.hint).toContain('fake chrome crashed')
    expect(existsSync(profile!)).toBe(false)
  })

  test('a Chrome that never finishes is killed at the timeout, exit 1', async () => {
    const { error, profile } = await render('hang', 500)
    expect(failure(error).message).toContain('did not finish rendering within 500ms')
    expect(existsSync(profile!)).toBe(false)
  })

  test('a plan without jobs starts nothing', async () => {
    const chrome = fakeChrome(mkdtempSync(join(dir, 'chrome-')))
    const images = await renderJobs({ ...plan, jobs: [] }, { chrome: chrome.bin, page: PAGE })
    expect(images.size).toBe(0)
    expect(chrome.calls()).toEqual([])
  })
})

describe('serveShots', () => {
  test('serves the page protocol under the token and nothing outside it', async () => {
    const server = serveShots(plan, { page: PAGE })
    try {
      const at = (route: string) => new URL(route, server.url).href
      const { origin, pathname } = new URL(server.url)

      const html = await fetch(server.url)
      expect(html.headers.get('content-type')).toContain('text/html')
      expect(await html.text()).toContain('<script type="module" src="page.js"></script>')

      const page = await fetch(at('page.js'))
      expect(page.headers.get('content-type')).toContain('text/javascript')
      expect(await page.text()).toBe(PAGE)

      expect(await (await fetch(at('plan.json'))).json()).toEqual(pagePlan(plan))

      const raw = await fetch(at('shot/ios-en-US-02'))
      expect(raw.headers.get('content-type')).toBe('image/png')
      expect(imageInfo(new Uint8Array(await raw.arrayBuffer()))).toMatchObject({ width: 2, height: 2 })

      const woff = await fetch(at('asset/0'))
      expect(woff.headers.get('content-type')).toBe('font/woff2')
      expect(await woff.text()).toBe('woff2 bytes')
      expect((await fetch(at('asset/1'))).headers.get('content-type')).toBe('image/svg+xml')

      for (const url of [
        `${origin}/`,
        `${origin}/plan.json`,
        `${origin}/not-the-token/plan.json`,
        `${origin}${pathname.slice(0, -1)}`,
        at('shot/ios-en-US-99'),
        at('asset/2'),
        at('asset/x'),
        at('nope'),
      ]) {
        expect((await fetch(url)).status).toBe(404)
      }
      expect((await fetch(at('out/ios-en-US-99'), { method: 'POST', body: 'x' })).status).toBe(404)
      expect((await fetch(`${origin}/done`, { method: 'POST', body: '{"ok":true}' })).status).toBe(404)

      const png = encodePng(4, 4, new Uint8Array(48))
      expect((await fetch(at('out/ios-en-US-02'), { method: 'POST', body: png as BodyInit })).ok).toBe(true)
      expect(server.images.get('ios-en-US-02')).toEqual(png)

      await fetch(at('done'), { method: 'POST', body: JSON.stringify({ ok: false, error: 'boom' }) })
      await fetch(at('done'), { method: 'POST', body: JSON.stringify({ ok: true }) })
      expect(await server.done).toEqual({ ok: false, error: 'boom' })
    } finally {
      await server.stop()
    }
  })

  test('a done message that is not a PageDone fails the run', async () => {
    const server = serveShots(plan, { page: PAGE })
    try {
      await fetch(new URL('done', server.url), { method: 'POST', body: 'not json' })
      expect((await server.done).ok).toBe(false)
    } finally {
      await server.stop()
    }
  })
})
