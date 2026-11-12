import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ExitCode, KitError } from '../../src/lib/errors'
import { encodePng, imageInfo } from '../../src/lib/image/png'
import { OPENER_FILE, openerHtml, openerTarget, renderJobs } from '../../src/lib/storeshots/render'
import { serveShots } from '../../src/lib/storeshots/server'
import { type ExportPlan, type Job, pagePlan, type Slide } from '../../src/lib/storeshots/types'
import { type FakeChromeMode, fakeChrome, LOCKED_DIR } from '../helpers/fake-chrome'

const dir = mkdtempSync(join(tmpdir(), 'kit-storeshots-render-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  delete process.env.FAKE_CHROME
  delete process.env.FAKE_CHROME_DELAY_MS
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
async function render(
  mode?: FakeChromeMode,
  timeoutMs?: number,
  opts: { plan?: ExportPlan; root?: string } = {},
) {
  const chrome = fakeChrome(mkdtempSync(join(dir, 'chrome-')))
  if (mode) process.env.FAKE_CHROME = mode
  const verbose: string[] = []
  const result = await renderJobs(opts.plan ?? plan, {
    chrome: chrome.bin,
    page: PAGE,
    timeoutMs,
    root: opts.root,
    verbose: (message) => verbose.push(message),
  }).then(
    (images) => ({ images, error: undefined }),
    (error: unknown) => ({ images: undefined, error }),
  )
  const run = chrome.runs()[0]
  const argv = run?.argv ?? []
  const profile = argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
  return { ...result, argv, profile, url: run?.url, verbose }
}

function failure(error: unknown): KitError {
  expect(error).toBeInstanceOf(KitError)
  const e = error as KitError
  expect(e.exitCode).toBe(ExitCode.failed)
  return e
}

describe('renderJobs', () => {
  test('returns one PNG per job at the job size, from Chrome run on a throwaway profile', async () => {
    const { images, argv, profile, url } = await render()
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
    // The server URL carries the path token, and argv is what `ps` shows every local user: Chrome
    // is handed a file in the work dir instead, and nothing on argv holds the token.
    expect(argv[6]).toBe(`file://${dirname(profile!)}/${OPENER_FILE}`)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)
    const token = new URL(url!).pathname.split('/')[1]!
    expect(argv.some((arg) => arg.includes(token) || arg.includes('http://'))).toBe(false)

    // The profile is gone, and so is the server.
    expect(profile).toBeDefined()
    expect(existsSync(profile!)).toBe(false)
    expect(existsSync(dirname(profile!))).toBe(false)
    await expect(fetch(new URL('plan.json', url))).rejects.toThrow()
  })

  test('the opener file leads to the URL it was written for, whatever the URL holds', () => {
    for (const url of ['http://127.0.0.1:4000/0123abcd/', 'http://127.0.0.1:1/a"b</script>/']) {
      const html = openerHtml(url)
      expect(openerTarget(html)).toBe(url)
      expect(html.match(/<\/script>/g)).toHaveLength(1)
    }
    expect(openerTarget('<html></html>')).toBeUndefined()
  })

  test('the work dir is private to the user while Chrome runs', async () => {
    const chrome = fakeChrome(mkdtempSync(join(dir, 'chrome-')))
    process.env.FAKE_CHROME = 'hang'
    const pending = renderJobs(plan, { chrome: chrome.bin, page: PAGE, timeoutMs: 1500 }).catch(() => {})
    while (chrome.runs().length === 0) await Bun.sleep(20)
    const opener = new URL(chrome.runs()[0]!.argv.at(-1)!).pathname
    expect(statSync(dirname(opener)).mode & 0o777).toBe(0o700)
    expect(statSync(opener).mode & 0o777).toBe(0o600)
    await pending
  })

  test('a temp dir that cannot be removed does not discard a finished render', async () => {
    const { images, error, profile, verbose } = await render('locked-profile')
    try {
      expect(error).toBeUndefined()
      expect([...(images?.keys() ?? [])]).toEqual(['ios-en-US-01', 'ios-en-US-02'])
      // Left behind, and said so at verbose level.
      expect(existsSync(join(profile!, LOCKED_DIR))).toBe(true)
      expect(verbose).toHaveLength(1)
      expect(verbose[0]).toContain(`Could not remove ${dirname(profile!)}`)
    } finally {
      chmodSync(join(profile!, LOCKED_DIR), 0o700)
      rmSync(dirname(profile!), { recursive: true, force: true })
    }
  })

  test('a Chrome that cannot be spawned is exit 4 with the install hint', async () => {
    const script = join(mkdtempSync(join(dir, 'chrome-')), 'not-chrome')
    writeFileSync(script, 'not a binary')
    const error = await renderJobs(plan, { chrome: script, page: PAGE }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(KitError)
    expect((error as KitError).exitCode).toBe(ExitCode.precondition)
    expect((error as KitError).message).toContain(`Cannot start Chrome at ${script}`)
    expect((error as KitError).hint).toContain('KIT_CHROME')
  })

  test('the timeout is idle time: a run longer than it finishes while images keep coming', async () => {
    // Five waits of 400ms make a 2s run; no gap between images comes near the 1500ms timeout.
    process.env.FAKE_CHROME_DELAY_MS = '400'
    const jobs = [1, 2, 3, 4].map((n) => job(`ios-en-US-0${n}`, 4, 4))
    const started = Date.now()
    const { images, error } = await render('slow', 1500, { plan: { ...plan, jobs } })
    expect(error).toBeUndefined()
    expect(images?.size).toBe(4)
    expect(Date.now() - started).toBeGreaterThan(1500)
  })

  test('a page failure on one job names the raw shot of that job', async () => {
    const { error } = await render('job-error', undefined, { root: dir })
    const e = failure(error)
    expect(e.message).toBe('The shots page failed on ios-en-US-01: fake job error')
    expect(e.hint).toBe('Its raw shot is home.png, for slide "Home" (slide-ios-en-US-01)')
    // Without a root the path is absolute.
    expect(failure((await render('job-error')).error).hint).toContain(`Its raw shot is ${shot},`)
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
    const e = failure(error)
    expect(e.message).toBe('Chrome did not finish rendering: no image came back for 500ms')
    expect(e.hint).toBe('0 of 2 images came back before that')
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
    const posted: string[] = []
    const server = serveShots(plan, { page: PAGE, onImage: (id) => posted.push(id) })
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
      // Only a PNG for a job of the plan counts as progress.
      expect(posted).toEqual(['ios-en-US-02'])

      const failed = { ok: false, error: 'boom', job: 'ios-en-US-02' }
      await fetch(at('done'), { method: 'POST', body: JSON.stringify(failed) })
      await fetch(at('done'), { method: 'POST', body: JSON.stringify({ ok: true }) })
      expect(await server.done).toEqual(failed)
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
