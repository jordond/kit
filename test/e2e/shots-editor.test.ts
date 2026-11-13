import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findChrome } from '../../src/lib/chrome'
import { DEFAULT_SETS, SET_SIZES } from '../../src/lib/storeshots/sizes'
import { type Fixture, fixture } from '../helpers/fixture'

/**
 * The built editor in a real Chrome, served by a real `kit shots studio` over a copy of
 * `test/fixtures/shots-app` (its version 2 project): `KIT_CHROME_TEST=1 bun test test/e2e/shots-editor.test.ts` after
 * `bun run build`. The three target canvases must draw something, and an edit made through the
 * panel must reach the project file on disk, minimal. Set `KIT_EDITOR_SHOT=<file.png>`
 * to keep a screenshot of the page.
 */

const root = resolve(import.meta.dir, '../..')
const enabled = process.env.KIT_CHROME_TEST === '1' && existsSync(join(root, 'dist/shots-editor/index.html'))

const TARGETS = ['ios', 'ipad', 'android'] as const

/** A minimal DevTools protocol client over one page. */
async function connect(port: number, url: string) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string }
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    ws.onopen = ok
    ws.onerror = fail
  })
  let id = 0
  const pending = new Map<number, (value: any) => void>()
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data))
    pending.get(msg.id)?.(msg)
  }
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((ok) => {
      const mine = ++id
      pending.set(mine, ok)
      ws.send(JSON.stringify({ id: mine, method, params }))
    })
  const evaluate = async <T>(expression: string): Promise<T> => {
    const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails))
    return msg.result?.result?.value as T
  }
  return { send, evaluate, close: () => ws.close() }
}

/** For each canvas of a target column: its pixel size and how many distinct colours a sample holds. */
const probe = `(() => [...document.querySelectorAll('[data-target] canvas')].map((c) => {
  const ctx = c.getContext('2d')
  const colours = new Set()
  if (c.width > 0 && c.height > 0) {
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < data.length; i += 4 * 7) colours.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2])
  }
  return { target: c.closest('[data-target]').dataset.target, width: c.width, height: c.height, colours: colours.size }
}))()`

/** Sets a number input the way a user typing would, so React sees the change. */
const setNumber = (field: string, value: number): string => `(() => {
  const input = document.querySelector('[data-field="${field}"] input[type=number]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${value}')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`

const click = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}).click()`

const status = `document.querySelector('[role=status]')?.textContent ?? ''`

describe.skipIf(!enabled)('the built shots editor in a real Chrome', () => {
  let f: Fixture
  let studio: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  let studioUrl = ''
  let profile: string
  let chrome: Bun.Subprocess

  beforeAll(async () => {
    f = fixture('shots-app', [])
    const config = join(f.dir, 'kit.config.ts')
    writeFileSync(config, readFileSync(config, 'utf8').replace('brand/studio.json', 'brand/studio.v2.json'))
    studio = f.spawn(['shots', 'studio', '--no-open'])
    const reader = studio.stderr.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    while (!studioUrl) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`kit exited before it printed a URL:\n${seen}`)
      seen += decoder.decode(value)
      studioUrl = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\//.exec(seen)?.[0] ?? ''
    }

    profile = mkdtempSync(join(tmpdir(), 'kit-editor-chrome-'))
    const bin = findChrome()
    if (bin === undefined) throw new Error('KIT_CHROME_TEST=1 needs Chrome: install it or set KIT_CHROME')
    chrome = Bun.spawn(
      [
        bin,
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1500,1500',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
  })

  afterAll(() => {
    chrome.kill()
    studio.kill('SIGINT')
    f.cleanup()
    rmSync(profile, { recursive: true, force: true })
  })

  async function debugPort(): Promise<number> {
    const portFile = join(profile, 'DevToolsActivePort')
    for (let i = 0; i < 100; i++) {
      if (existsSync(portFile)) return Number(readFileSync(portFile, 'utf8').split('\n')[0])
      await Bun.sleep(100)
    }
    throw new Error('Chrome did not open a debugging port')
  }

  test('the three target canvases draw the active slide', async () => {
    const page = await connect(await debugPort(), studioUrl)
    try {
      type Probe = { target: string; width: number; height: number; colours: number }[]
      let canvases: Probe = []
      for (let i = 0; i < 100; i++) {
        canvases = await page.evaluate<Probe>(probe)
        if (canvases.length === 3 && canvases.every((c) => c.colours > 3)) break
        await Bun.sleep(150)
      }
      expect(canvases.map((c) => c.target)).toEqual([...TARGETS])
      for (const c of canvases) {
        expect(c.width).toBeGreaterThan(50)
        // A gradient background alone gives more than a handful of colours; a blank canvas gives one.
        expect(c.colours).toBeGreaterThan(3)
      }

      // Preview resolution: well under the export size.
      expect(canvases[0]!.width).toBeLessThan(SET_SIZES[DEFAULT_SETS.ios].width)
    } finally {
      const out = process.env.KIT_EDITOR_SHOT
      if (out) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
      }
      page.close()
    }
  }, 60_000)

  test('an edit through the panel is saved to the file, and the file stays minimal', async () => {
    const file = join(f.dir, 'brand/studio.v2.json')
    const original = JSON.parse(readFileSync(file, 'utf8'))
    const page = await connect(await debugPort(), studioUrl)
    const waitFor = async (expression: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (await page.evaluate<boolean>(expression)) return
        await Bun.sleep(100)
      }
      throw new Error(`Timed out waiting for: ${expression}`)
    }
    const saved = () => JSON.parse(readFileSync(file, 'utf8'))
    try {
      await waitFor(`!!document.querySelector('[data-field="device.scale"]')`)

      // All slides: the project style gets the value; no slide is touched.
      await page.evaluate(setNumber('device.scale', 0.5))
      await waitFor(`(${status}) === 'Saved'`)
      const edited = saved()
      expect(edited.style.device).toEqual({ ...original.style.device, scale: 0.5 })
      expect(edited.slides).toEqual(original.slides)

      // Back to the built-in value: the override goes, the file is as it was.
      await page.evaluate(setNumber('device.scale', 0.76))
      await waitFor(
        `(${status}) === 'Saved' && !document.querySelector('[data-field="device.scale"] [title^="Set for all"]')`,
      )
      expect(saved()).toEqual(original)

      // This slide: the override is on the slide; its reset removes it and the empty object.
      await page.evaluate(
        `[...document.querySelectorAll('[role=radio]')].find((b) => b.textContent === 'This slide').click()`,
      )
      await page.evaluate(setNumber('background.angle', 90))
      await waitFor(`(${status}) === 'Saved'`)
      expect(saved().slides[0].style).toEqual({ background: { angle: 90 } })
      expect(saved().style).toEqual(original.style)
      await page.evaluate(click('[aria-label="Reset Angle"]'))
      await waitFor(
        `(${status}) === 'Saved' && !document.querySelector('[aria-label="Reset Angle"]:not([disabled])')`,
      )
      expect(saved()).toEqual(original)
    } finally {
      const out = process.env.KIT_EDITOR_SHOT
      if (out) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
      }
      page.close()
    }
  }, 60_000)
})
