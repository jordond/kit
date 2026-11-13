import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findChrome } from '../../src/lib/chrome'
import { DEFAULT_SETS, SET_SIZES } from '../../src/lib/storeshots/sizes'
import { type Fixture, fixture } from '../helpers/fixture'

/**
 * The built editor in a real Chrome, served by a real `kit shots studio` over a copy of
 * `test/fixtures/shots-app` (its version 2 project): `KIT_CHROME_TEST=1 bun test test/e2e/shots-editor.test.ts` after
 * `bun run build`. The three target canvases must draw something, and an edit made through the
 * panel must reach the project file on disk, minimal. Presets, the palette, overflow warnings, the
 * actual-size view, dragging the device and the export button are driven through the page too. Set `KIT_EDITOR_SHOT=<file.png>`
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

type Page = Awaited<ReturnType<typeof connect>>

/** Polls `expression` in the page until it is truthy. */
async function until(page: Page, expression: string, what = expression): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

/** Sets the text of the field labelled `label` the way typing would. */
const setText = (label: string, value: string): string => `(() => {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent === ${JSON.stringify(label)})
  const el = document.getElementById(label.htmlFor)
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
})()`

/** Keeps a screenshot when `KIT_EDITOR_SHOT` is set; `name` adds a suffix to the file name. */
const keepShot = async (page: Page, name?: string): Promise<void> => {
  const base = process.env.KIT_EDITOR_SHOT
  const out = base && name ? base.replace(/\.png$/, `-${name}.png`) : base
  if (out) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  }
}

/** Every `.png` under `dir`. */
function pngs(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? pngs(join(dir, e.name)) : e.name.endsWith('.png') ? [join(dir, e.name)] : [],
  )
}

describe.skipIf(!enabled)('the built shots editor in a real Chrome', () => {
  let f: Fixture
  let studio: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  let studioUrl = ''
  let profile: string
  let chrome: Bun.Subprocess

  beforeAll(async () => {
    f = fixture('shots-app', [])
    const config = join(f.dir, 'kit.config.ts')
    // The repo's own presets and palette, beside the built-in presets.
    writeFileSync(
      config,
      readFileSync(config, 'utf8')
        .replace('brand/studio.json', 'brand/studio.v2.json')
        .replace(
          "project: 'brand/studio.v2.json',",
          "project: 'brand/studio.v2.json', presets: { sand: { background: { primaryColor: '#f4ecd8' } } }, palette: { ink: '#2c1e14', sand: '#f4ecd8' },",
        ),
    )
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
  test('a built-in preset and a repo preset are one undoable edit each, and the file keeps what they do not name', async () => {
    const file = join(f.dir, 'brand/studio.v2.json')
    const original = JSON.parse(readFileSync(file, 'utf8'))
    const saved = () => JSON.parse(readFileSync(file, 'utf8'))
    const page = await connect(await debugPort(), studioUrl)
    try {
      await until(page, `!!document.querySelector('[data-preset="dark"]')`)
      // The repo's preset is listed after kit's three.
      expect(
        await page.evaluate<string[]>(
          `[...document.querySelectorAll('[data-preset]')].map((b) => b.dataset.preset)`,
        ),
      ).toEqual(['light', 'dark', 'bold-colour', 'sand'])

      await page.evaluate(click('[data-preset="dark"]'))
      await until(page, `(${status}) === 'Saved'`)
      const dark = saved()
      expect(dark.style.background).toMatchObject({ primaryColor: '#1c1c22', type: 'linear-gradient' })
      expect(dark.style.headline).toEqual({ ...original.style.headline, color: '#ffffff' })
      // Fields the preset does not name stay; slides are untouched.
      expect(dark.style.device).toEqual(original.style.device)
      expect(dark.slides).toEqual(original.slides)

      await page.evaluate(click('[data-preset="sand"]'))
      await until(
        page,
        `(${status}) === 'Saved' && document.querySelector('[data-field="background.primaryColor"] input[type=text]').value === '#f4ecd8'`,
      )
      expect(saved().style.background.primaryColor).toBe('#f4ecd8')
      expect(saved().style.headline.color).toBe('#ffffff')

      // Two presets, two undo steps, back to the file as it was.
      await page.evaluate(click('button[title^="Undo"]'))
      await page.evaluate(click('button[title^="Undo"]'))
      await until(
        page,
        `(${status}) === 'Saved' && !document.querySelector('button[title^="Undo"]:not([disabled])')`,
      )
      expect(saved()).toEqual(original)
    } finally {
      await keepShot(page)
      page.close()
    }
  }, 60_000)

  test('the palette shows as swatches beside a colour control and a click writes the colour', async () => {
    const file = join(f.dir, 'brand/studio.v2.json')
    const original = JSON.parse(readFileSync(file, 'utf8'))
    const page = await connect(await debugPort(), studioUrl)
    try {
      const swatches = `[data-field="headline.color"] [data-palette] button`
      await until(page, `document.querySelectorAll('${swatches}').length === 2`)
      expect(
        await page.evaluate<string[]>(`[...document.querySelectorAll('${swatches}')].map((b) => b.title)`),
      ).toEqual(['ink #2c1e14', 'sand #f4ecd8'])
      await page.evaluate(`document.querySelectorAll('${swatches}')[1].click()`)
      await until(page, `(${status}) === 'Saved'`)
      expect(JSON.parse(readFileSync(file, 'utf8')).style.headline.color).toBe('#f4ecd8')
      // The swatch of the current colour is marked.
      expect(
        await page.evaluate<string>(
          `document.querySelectorAll('${swatches}')[1].getAttribute('aria-pressed')`,
        ),
      ).toBe('true')
      await page.evaluate(`document.querySelectorAll('${swatches}')[0].click()`)
      await until(page, `(${status}) === 'Saved'`)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(original)
    } finally {
      page.close()
    }
  }, 60_000)

  test('a deliberately long headline gets an overflow marker on its slide and its target columns, naming locale, target and reason', async () => {
    const file = join(f.dir, 'brand/studio.v2.json')
    const original = JSON.parse(readFileSync(file, 'utf8'))
    const page = await connect(await debugPort(), studioUrl)
    try {
      await until(page, `!!document.querySelector('[data-field="device.scale"]')`)
      // The fixture's own slides fit: wait for the monitor's first walk, then check there is no marker.
      await Bun.sleep(1500)
      expect(await page.evaluate<number>(`document.querySelectorAll('[data-overflow]').length`)).toBe(0)

      const long = Array.from({ length: 24 }, (_, i) => `headline${i}`).join(' ')
      await page.evaluate(setText('Headline', long))
      await until(
        page,
        `document.querySelectorAll('nav[aria-label=Slides] [data-overflow]').length === 1`,
        'a filmstrip marker',
      )
      await until(page, `document.querySelectorAll('main [data-overflow]').length >= 1`, 'a column marker')
      const title = await page.evaluate<string>(
        `document.querySelector('nav[aria-label=Slides] [data-overflow]').title`,
      )
      expect(title).toContain('en-US on iPhone')
      expect(title).toMatch(/the headline wraps to \d+ lines/)
      await keepShot(page, 'overflow')

      await page.evaluate(setText('Headline', original.slides[0].headline))
      await until(page, `document.querySelectorAll('[data-overflow]').length === 0`, 'the markers to go')

      // Every locale is checked, not only the previewed one: a long French headline is flagged
      // while English is on screen.
      const pickLocale = (code: string) => `(() => {
        const select = document.querySelector('header select')
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '${code}')
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })()`
      await page.evaluate(pickLocale('fr-FR'))
      await until(
        page,
        `[...document.querySelectorAll('label')].some((l) => l.textContent === 'Headline (fr-FR)')`,
      )
      await page.evaluate(setText('Headline (fr-FR)', long))
      await page.evaluate(pickLocale('en-US'))
      await until(
        page,
        `document.querySelectorAll('nav[aria-label=Slides] [data-overflow]').length === 1`,
        'a marker for fr-FR',
      )
      const fr = await page.evaluate<string>(
        `document.querySelector('nav[aria-label=Slides] [data-overflow]').title`,
      )
      expect(fr).toContain('fr-FR on iPhone')
      expect(fr).toContain('fr-FR on Android')
      expect(fr).not.toContain('en-US')
      expect(
        await page.evaluate<string>(
          `document.querySelector('main [data-overflow]').getAttribute('data-overflow')`,
        ),
      ).toContain('fr-FR:ios')

      await page.evaluate(pickLocale('fr-FR'))
      await until(
        page,
        `[...document.querySelectorAll('label')].some((l) => l.textContent === 'Headline (fr-FR)')`,
      )
      await page.evaluate(setText('Headline (fr-FR)', original.locales['fr-FR'].home.headline))
      await until(page, `document.querySelectorAll('[data-overflow]').length === 0`, 'the markers to go')
      await until(page, `(${status}) === 'Saved'`)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(original)
    } finally {
      page.close()
    }
  }, 60_000)

  test('actual size draws one target at its export resolution in a scrollable view', async () => {
    const page = await connect(await debugPort(), studioUrl)
    try {
      await until(page, `!!document.querySelector('[data-actual-size="ios"]')`)
      await page.evaluate(click('[data-actual-size="ios"]'))
      await until(
        page,
        `(() => { const c = document.querySelector('[data-target="ios"] canvas'); return c && c.width === ${SET_SIZES[DEFAULT_SETS.ios].width} && c.getBoundingClientRect().width === ${SET_SIZES[DEFAULT_SETS.ios].width} })()`,
        'the iPhone canvas at export size',
      )
      const scroll = await page.evaluate<{ over: boolean; others: number }>(`(() => {
        const el = document.querySelector('[data-target="ios"] [data-scroll]')
        const others = [...document.querySelectorAll('[data-target]')].filter((t) => t.dataset.target !== 'ios').map((t) => t.querySelector('canvas').width)
        return { over: el.scrollHeight > el.clientHeight && el.scrollWidth > el.clientWidth, others: Math.max(...others) }
      })()`)
      expect(scroll.over).toBe(true)
      // The other columns stay at preview resolution.
      expect(scroll.others).toBeLessThan(SET_SIZES[DEFAULT_SETS.ipad].width)
      await page.evaluate(click('[data-actual-size="ios"]'))
      await until(
        page,
        `document.querySelector('[data-target="ios"] canvas').width < ${SET_SIZES[DEFAULT_SETS.ios].width}`,
      )
    } finally {
      page.close()
    }
  }, 60_000)

  test('dragging, scrolling and arrow keys place the device at the current scope, one undo step per gesture', async () => {
    const file = join(f.dir, 'brand/studio.v2.json')
    const original = JSON.parse(readFileSync(file, 'utf8'))
    const saved = () => JSON.parse(readFileSync(file, 'utf8'))
    const page = await connect(await debugPort(), studioUrl)
    try {
      const overlay = `document.querySelector('[data-gestures="ios"]')`
      await until(page, `!!${overlay} && document.querySelector('[data-target="ios"] canvas').width > 50`)
      await Bun.sleep(500)
      const rect = await page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => {
        const r = ${overlay}.getBoundingClientRect()
        return { x: r.left, y: r.top, w: r.width, h: r.height }
      })()`)
      // The device sits in the lower part of the canvas (bottom-peek).
      const from = { x: rect.x + rect.w / 2, y: rect.y + rect.h * 0.8 }
      const mouse = (type: string, x: number, y: number, extra: object = {}) =>
        page.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          clickCount: 1,
          ...extra,
        })

      // A press off the device does nothing.
      await mouse('mousePressed', rect.x + 2, rect.y + 2)
      await mouse('mouseMoved', rect.x + 30, rect.y + 30)
      await mouse('mouseReleased', rect.x + 30, rect.y + 30)
      await Bun.sleep(1200)
      expect(saved()).toEqual(original)

      // Drag by 10% of the width right and 5% of the height up.
      const dx = rect.w * 0.1
      const dy = -rect.h * 0.05
      await mouse('mousePressed', from.x, from.y)
      for (let i = 1; i <= 5; i++) await mouse('mouseMoved', from.x + (dx * i) / 5, from.y + (dy * i) / 5)
      await mouse('mouseReleased', from.x + dx, from.y + dy)
      await until(page, `(${status}) === 'Saved'`)
      const device = saved().style.device
      expect(device.xOffset).toBeGreaterThan(9)
      expect(device.xOffset).toBeLessThan(11)
      // The built-in yOffset is 2; the drag moved it up by about 5.
      expect(device.yOffset).toBeGreaterThan(-4)
      expect(device.yOffset).toBeLessThan(-2)
      // The panel sliders are in step with it.
      const panel = await page.evaluate<string>(
        `document.querySelector('[data-field="device.xOffset"] input[type=number]').value`,
      )
      expect(Number(panel)).toBe(device.xOffset)
      // Focus moved to the dragged target.
      expect(await page.evaluate<string>(`document.querySelector('[aria-pressed=true]').textContent`)).toBe(
        'iPhone',
      )

      // The whole drag is one undo step.
      await page.evaluate(click('button[title^="Undo"]'))
      await until(
        page,
        `(${status}) === 'Saved' && !document.querySelector('button[title^="Undo"]:not([disabled])')`,
      )
      expect(saved()).toEqual(original)

      // Scrolling over the device scales it, as one step too.
      for (let i = 0; i < 3; i++)
        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: from.x,
          y: from.y,
          deltaX: 0,
          deltaY: -120,
        })
      await until(page, `(${status}) === 'Saved'`)
      expect(saved().style.device.scale).toBeGreaterThan(0.8)
      await page.evaluate(click('button[title^="Undo"]'))
      await until(
        page,
        `(${status}) === 'Saved' && !document.querySelector('button[title^="Undo"]:not([disabled])')`,
      )
      expect(saved()).toEqual(original)

      // Arrow keys on the focused canvas nudge half a percent.
      await page.evaluate(`${overlay}.focus()`)
      const key = (k: string) =>
        page.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: k,
          code: k,
          windowsVirtualKeyCode: 39,
        })
      await key('ArrowRight')
      await key('ArrowRight')
      await until(page, `(${status}) === 'Saved'`)
      expect(saved().style.device.xOffset).toBe(1)
      await page.evaluate(click('button[title^="Undo"]'))
      await until(
        page,
        `(${status}) === 'Saved' && !document.querySelector('button[title^="Undo"]:not([disabled])')`,
      )
      expect(saved()).toEqual(original)
    } finally {
      page.close()
    }
  }, 90_000)

  test('the export button saves, runs the export and shows what was written', async () => {
    const page = await connect(await debugPort(), studioUrl)
    try {
      await until(
        page,
        `[...document.querySelectorAll('header button')].some((b) => b.textContent.trim() === 'Export')`,
      )
      const before = pngs(join(f.dir, 'fastlane')).length
      await page.evaluate(
        `[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Export').click()`,
      )
      await until(page, `!!document.querySelector('[data-export-run]')`)
      // One store, one locale: kept small.
      await page.evaluate(
        `[...document.querySelectorAll('[role=dialog] label')].find((l) => l.textContent.includes('Google Play')).querySelector('input').click()`,
      )
      await page.evaluate(click('[data-export-run]'))
      await until(
        page,
        `['done', 'error'].includes(document.querySelector('[data-export-state]').dataset.exportState)`,
        'the export to finish',
      )
      const state = await page.evaluate<string>(`document.querySelector('[data-export-state]').textContent`)
      expect(state).toMatch(/\d+ files? written/)
      const written = pngs(join(f.dir, 'fastlane'))
      expect(written.length).toBeGreaterThan(before)
      // Apple only: nothing in the Google tree.
      expect(written.some((file) => file.includes('/android/'))).toBe(false)
      await keepShot(page)
    } finally {
      page.close()
    }
  }, 120_000)
})
