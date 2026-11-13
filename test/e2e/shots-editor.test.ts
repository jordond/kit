import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findChrome } from '../../src/lib/chrome'
import { BUILT_IN_STYLE } from '../../src/lib/storeshots/resolve'
import { DEFAULT_SETS, SET_SIZES } from '../../src/lib/storeshots/sizes'
import type { StudioSession, StudioShots } from '../../src/lib/storeshots/studio-api'

/**
 * The built editor in a real Chrome, against a small mock of the studio API that serves
 * `test/fixtures/shots-app`: `KIT_CHROME_TEST=1 bun test test/e2e/shots-editor.test.ts` after
 * `bun run build`. The three target canvases must draw something. Set `KIT_EDITOR_SHOT=<file.png>`
 * to keep a screenshot of the page.
 */

const root = resolve(import.meta.dir, '../..')
const editor = join(root, 'dist/shots-editor')
const app = join(root, 'test/fixtures/shots-app')
const enabled = process.env.KIT_CHROME_TEST === '1' && existsSync(join(editor, 'index.html'))

const TOKEN = 'tok123'
const TARGETS = ['ios', 'ipad', 'android'] as const

/** A PNG's pixel size, from its IHDR. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function shots(): StudioShots {
  const out: StudioShots = { ios: [], ipad: [], android: [] }
  for (const target of TARGETS) {
    const dir = join(app, 'maestro/screenshots', target)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.png')) {
        out[target].push({ file: entry.name, path: entry.name, ...pngSize(join(dir, entry.name)) })
      } else if (entry.isDirectory()) {
        for (const name of readdirSync(join(dir, entry.name))) {
          const path = `${entry.name}/${name}`
          out[target].push({ file: name, path, locale: entry.name, ...pngSize(join(dir, path)) })
        }
      }
    }
  }
  return out
}

function session(): StudioSession {
  const sets = Object.fromEntries(
    TARGETS.map((t) => [
      t,
      { id: DEFAULT_SETS[t], store: t === 'android' ? 'google' : 'apple', ...SET_SIZES[DEFAULT_SETS[t]] },
    ]),
  ) as StudioSession['sets']
  return {
    projectPath: 'brand/studio.v2.json',
    rawPath: 'maestro/screenshots',
    targets: TARGETS,
    sets,
    locales: { apple: ['en-US', 'fr-FR'], google: ['en-US'] },
    fonts: [{ family: 'Kit Fixture', url: 'api/asset/0', weight: '400 800' }],
    brand: { mark: 'api/asset/1', wordmark: 'shots', color: '#2c1e14', font: 'Kit Fixture' },
    builtIn: BUILT_IN_STYLE,
  }
}

const json = (body: unknown): Response => Response.json(body, { headers: { 'cache-control': 'no-store' } })

/** The API of `studio-api.ts` that a read-only editor calls, over the fixture. */
function mockApi(req: Request): Response {
  const url = new URL(req.url)
  const [, token, ...rest] = url.pathname.split('/')
  if (token !== TOKEN) return new Response('not found', { status: 404 })
  const path = rest.join('/')
  if (path === '' || path === 'index.html') return file(join(editor, 'index.html'))
  if (path.startsWith('assets/')) return file(join(editor, path))
  if (path === 'api/session') return json(session())
  if (path === 'api/project') {
    const project = JSON.parse(readFileSync(join(app, 'brand/studio.v2.json'), 'utf8'))
    return json({ project, hash: 'h1' })
  }
  if (path === 'api/shots') return json(shots())
  if (path === 'api/asset/0') return file(join(app, 'brand/fonts/fixture.ttf'))
  if (path === 'api/asset/1') return file(join(app, 'brand/mark.svg'))
  const shot = path.match(/^api\/shot\/(ios|ipad|android)\/(.+)$/)
  if (shot && !shot[2]!.includes('..')) {
    return file(join(app, 'maestro/screenshots', shot[1]!, ...decodeURIComponent(shot[2]!).split('/')))
  }
  return new Response('not found', { status: 404 })
}

const file = (path: string): Response =>
  new Response(Bun.file(path), { headers: { 'cache-control': 'no-store' } })

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

describe.skipIf(!enabled)('the built shots editor in a real Chrome', () => {
  let server: ReturnType<typeof Bun.serve>
  let profile: string
  let chrome: Bun.Subprocess

  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: mockApi })
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
        '--window-size=1500,900',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
  })

  afterAll(() => {
    chrome.kill()
    void server.stop(true)
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
    const page = await connect(await debugPort(), `http://127.0.0.1:${server.port}/${TOKEN}/`)
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

      const out = process.env.KIT_EDITOR_SHOT
      if (out) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
      }
    } finally {
      page.close()
    }
  }, 60_000)
})
