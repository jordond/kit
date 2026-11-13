import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExitCode, KitError } from '../../src/lib/errors'
import { encodePng } from '../../src/lib/image/png'
import { BUILT_IN_STYLE } from '../../src/lib/storeshots/resolve'
import type {
  StudioError,
  StudioExportRequest,
  StudioProjectFile,
  StudioSaved,
  StudioSession,
  StudioShot,
  StudioShots,
} from '../../src/lib/storeshots/studio-api'
import { serveStudio, type StudioServer } from '../../src/lib/storeshots/studio-server'
import type { ExportResult, ProjectV2 } from '../../src/lib/storeshots/types'

const base = mkdtempSync(join(tmpdir(), 'kit-studio-server-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const png = (width: number, height: number) => encodePng(width, height, new Uint8Array(width * height * 3))
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const PROJECT: ProjectV2 = { version: 2, slides: [{ shot: '01-home.png', headline: 'Hello' }] }

let dir: string
let server: StudioServer | undefined
let exports: StudioExportRequest[]
let exportError: Error | undefined

const projectFile = () => join(dir, 'brand', 'studio.json')
const rawDir = () => join(dir, 'raw')

function start(editorDir?: string) {
  const session: StudioSession = {
    projectPath: 'brand/studio.json',
    rawPath: 'raw',
    targets: ['ios', 'ipad', 'android'],
    sets: {
      ios: { id: 'iphone-6.9', store: 'apple', width: 1320, height: 2868 },
      ipad: { id: 'ipad-13', store: 'apple', width: 2064, height: 2752 },
      android: { id: 'phone', store: 'google', width: 1440, height: 2560 },
    },
    locales: { apple: ['en-US'], google: ['en-US'] },
    fonts: [{ family: 'Kit Fixture', url: 'asset/0', weight: '400 800' }],
    brand: { mark: 'asset/1' },
    builtIn: BUILT_IN_STYLE,
  }
  server = serveStudio({
    session,
    projectFile: projectFile(),
    rawDir: rawDir(),
    assets: [join(dir, 'font.ttf'), join(dir, 'mark.svg')],
    editorDir,
    runExport: async (request) => {
      exports.push(request)
      if (exportError) throw exportError
      return { dryRun: false, stores: request.stores, written: [], removed: [], skipped: [] } as ExportResult
    },
  })
  return server.url
}

beforeEach(() => {
  dir = mkdtempSync(join(base, 'repo-'))
  mkdirSync(join(dir, 'brand'))
  writeFileSync(join(dir, 'font.ttf'), 'font bytes')
  writeFileSync(join(dir, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  mkdirSync(join(rawDir(), 'ios', 'fr-FR'), { recursive: true })
  mkdirSync(join(rawDir(), 'android'), { recursive: true })
  writeFileSync(join(rawDir(), 'ios', '01-home.png'), png(3, 5))
  writeFileSync(join(rawDir(), 'ios', 'fr-FR', '01-home.png'), png(4, 6))
  writeFileSync(join(rawDir(), 'ios', 'notes.txt'), 'not a shot')
  writeFileSync(join(rawDir(), 'android', '02-journal.png'), png(2, 2))
  writeFileSync(join(dir, 'secret.txt'), 'outside the raw dir')
  exports = []
  exportError = undefined
})
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const text = (value: unknown) => JSON.stringify(value)
const put = (url: string, body: unknown) => fetch(`${url}api/project`, { method: 'PUT', body: text(body) })
const saved = () => JSON.parse(readFileSync(projectFile(), 'utf8')) as ProjectV2

describe('hardening', () => {
  test('every route needs the token and answers no-store', async () => {
    const url = start()
    const origin = new URL(url).origin
    for (const path of ['/', '/api/session', '/wrong/api/session', '/api/project', `/${'0'.repeat(32)}/`]) {
      expect((await fetch(origin + path)).status).toBe(404)
    }
    const res = await fetch(`${url}api/session`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(new URL(url).hostname).toBe('127.0.0.1')
  })

  test('a method a route does not take is 404', async () => {
    const url = start()
    expect((await fetch(`${url}api/session`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${url}api/shots`, { method: 'POST' })).status).toBe(404)
  })
})

describe('session', () => {
  test('is the session the command built', async () => {
    const url = start()
    const session = (await (await fetch(`${url}api/session`)).json()) as StudioSession
    expect(session.projectPath).toBe('brand/studio.json')
    expect(session.targets).toEqual(['ios', 'ipad', 'android'])
    expect(session.sets.android).toEqual({ id: 'phone', store: 'google', width: 1440, height: 2560 })
    expect(session.fonts[0]?.url).toBe('asset/0')
    expect(session.builtIn.headline.fontSize).toBe(BUILT_IN_STYLE.headline.fontSize)
  })
})

describe('placeholder and editor files', () => {
  test('without a built editor the page says so and the API still works', async () => {
    const url = start(join(dir, 'no-editor'))
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('not built')
    expect((await fetch(`${url}assets/x.js`)).status).toBe(404)
    expect((await fetch(`${url}api/session`)).status).toBe(200)
  })

  test('a built editor is served under the token with content types, and stays inside its dir', async () => {
    const editor = join(dir, 'editor')
    mkdirSync(join(editor, 'assets'), { recursive: true })
    writeFileSync(join(editor, 'index.html'), '<script src="./assets/app.js"></script>')
    writeFileSync(join(editor, 'assets', 'app.js'), 'console.log(1)')
    const url = start(editor)
    expect(await (await fetch(url)).text()).toContain('./assets/app.js')
    const js = await fetch(`${url}assets/app.js`)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(js.headers.get('cache-control')).toBe('no-store')
    expect((await fetch(`${url}assets/missing.js`)).status).toBe(404)
    const origin = new URL(url).origin
    const prefix = new URL(url).pathname
    for (const escape of [
      '../secret.txt',
      '%2e%2e/secret.txt',
      '..%2fsecret.txt',
      'assets/..%2f..%2fsecret.txt',
    ]) {
      const res = await fetch(`${origin}${prefix}${escape}`)
      expect(res.status).toBe(404)
    }
  })
})

describe('api/project', () => {
  test('404 when there is no file', async () => {
    const url = start()
    const res = await fetch(`${url}api/project`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as StudioError).error).toContain('brand/studio.json')
  })

  test('create with hash null, read back, save with the hash it returned', async () => {
    const url = start()
    const created = await put(url, { project: PROJECT, hash: null })
    expect(created.status).toBe(200)
    const { hash } = (await created.json()) as StudioSaved
    expect(saved()).toEqual(PROJECT)

    const read = (await (await fetch(`${url}api/project`)).json()) as StudioProjectFile
    expect(read.project).toEqual(PROJECT)
    expect(read.hash).toBe(hash)

    const next: ProjectV2 = { ...PROJECT, slides: [{ shot: '01-home.png', headline: 'Changed' }] }
    const res = await put(url, { project: next, hash })
    expect(res.status).toBe(200)
    const after = ((await res.json()) as StudioSaved).hash
    expect(after).not.toBe(hash)
    expect(saved().slides[0]?.headline).toBe('Changed')
    expect(((await (await fetch(`${url}api/project`)).json()) as StudioProjectFile).hash).toBe(after)
  })

  test('creating over a file that exists is 409 and leaves it alone', async () => {
    const url = start()
    writeFileSync(projectFile(), `${JSON.stringify(PROJECT)}\n`)
    const res = await put(url, { project: { ...PROJECT, slides: [] }, hash: null })
    expect(res.status).toBe(409)
    expect(saved()).toEqual(PROJECT)
  })

  test('a stale hash is 409 and nothing is written', async () => {
    const url = start()
    const first = (await (await put(url, { project: PROJECT, hash: null })).json()) as StudioSaved
    const changed = `${JSON.stringify({ ...PROJECT, slides: [{ shot: 'x.png', headline: 'Edited by hand' }] })}\n`
    writeFileSync(projectFile(), changed)
    const res = await put(url, { project: PROJECT, hash: first.hash })
    expect(res.status).toBe(409)
    expect(((await res.json()) as StudioError).error).toContain('changed on disk')
    expect(readFileSync(projectFile(), 'utf8')).toBe(changed)
  })

  test('a hash for a file that is gone is 409', async () => {
    const url = start()
    expect((await put(url, { project: PROJECT, hash: 'a'.repeat(64) })).status).toBe(409)
  })

  test('an invalid project is 422 with issue paths, and nothing is written', async () => {
    const url = start()
    await put(url, { project: PROJECT, hash: null })
    const before = readFileSync(projectFile(), 'utf8')
    const hash = ((await (await fetch(`${url}api/project`)).json()) as StudioProjectFile).hash
    const bad = { version: 2, slides: [{ shot: '', headline: 3, unknown: true }] }
    const res = await put(url, { project: bad, hash })
    expect(res.status).toBe(422)
    const body = (await res.json()) as StudioError
    expect(body.issues?.some((line) => line.startsWith('slides.0.shot:'))).toBe(true)
    expect(body.issues?.some((line) => line.startsWith('slides.0.headline:'))).toBe(true)
    expect(readFileSync(projectFile(), 'utf8')).toBe(before)
    expect((await put(url, 'nope')).status).toBe(422)
    expect((await fetch(`${url}api/project`, { method: 'PUT', body: '{' })).status).toBe(422)
  })

  test('a write leaves no temp file and replaces by rename', async () => {
    const url = start()
    await put(url, { project: PROJECT, hash: null })
    expect(readdirSync(join(dir, 'brand'))).toEqual(['studio.json'])
  })

  test('a file that is not a valid project is 422 on read, not an editable default', async () => {
    const url = start()
    writeFileSync(projectFile(), '{ "version": 2, "slides": 5 }')
    const res = await fetch(`${url}api/project`)
    expect(res.status).toBe(422)
    expect(((await res.json()) as StudioError).issues?.[0]).toContain('slides')
    writeFileSync(projectFile(), 'not json')
    expect((await fetch(`${url}api/project`)).status).toBe(422)
  })
})

describe('api/shots', () => {
  test('lists raw shots per target with sizes, base shots then locale dirs', async () => {
    const url = start()
    const shots = (await (await fetch(`${url}api/shots`)).json()) as StudioShots
    expect(shots.ios).toEqual([
      { file: '01-home.png', path: '01-home.png', width: 3, height: 5 },
      { file: '01-home.png', path: 'fr-FR/01-home.png', locale: 'fr-FR', width: 4, height: 6 },
    ])
    expect(shots.ipad).toEqual([])
    expect(shots.android).toEqual([{ file: '02-journal.png', path: '02-journal.png', width: 2, height: 2 }])
  })

  test('an absent raw dir lists nothing', async () => {
    rmSync(rawDir(), { recursive: true })
    const url = start()
    expect(await (await fetch(`${url}api/shots`)).json()).toEqual({ ios: [], ipad: [], android: [] })
  })

  test('a file that is not a readable PNG is left out', async () => {
    writeFileSync(join(rawDir(), 'ios', 'broken.png'), 'not a png')
    const url = start()
    const shots = (await (await fetch(`${url}api/shots`)).json()) as StudioShots
    expect(shots.ios.map((s) => s.path)).toEqual(['01-home.png', 'fr-FR/01-home.png'])
  })
})

describe('api/shot GET', () => {
  test('serves a listed shot, also in a locale dir', async () => {
    const url = start()
    const base = await fetch(`${url}api/shot/ios/01-home.png`)
    expect(base.headers.get('content-type')).toBe('image/png')
    expect(b64(new Uint8Array(await base.arrayBuffer()))).toBe(b64(png(3, 5)))
    const fr = await fetch(`${url}api/shot/ios/fr-FR/01-home.png`)
    expect(b64(new Uint8Array(await fr.arrayBuffer()))).toBe(b64(png(4, 6)))
  })

  test('rejects what the listing does not hold: traversal, other targets, non-shots', async () => {
    const url = start()
    const origin = new URL(url).origin
    const prefix = new URL(url).pathname
    const paths = [
      'api/shot/ios/notes.txt',
      'api/shot/ios/missing.png',
      'api/shot/ios/..%2f..%2fsecret.txt',
      'api/shot/ios/%2e%2e/%2e%2e/secret.txt',
      'api/shot/ios/../../secret.txt',
      'api/shot/ios/fr-FR/../notes.txt',
      'api/shot/ios/%2Fetc%2Fpasswd',
      'api/shot/ios/fr-FR/..%5c..%5csecret.txt',
      'api/shot/ios/%00.png',
      'api/shot/ios/%E0%A4%A.png',
      'api/shot/tablet/01-home.png',
      'api/shot/ios',
      'api/shot/..%2fraw/ios/01-home.png',
      'api/shot/android/01-home.png',
    ]
    for (const path of paths) {
      expect(`${path}: ${(await fetch(`${origin}${prefix}${path}`)).status}`).toBe(`${path}: 404`)
    }
  })
})

describe('api/shot POST', () => {
  const upload = (url: string, path: string, bytes: Uint8Array | string = png(8, 9), query = '') =>
    fetch(`${url}api/shot/${path}${query}`, {
      method: 'POST',
      body: typeof bytes === 'string' ? bytes : Buffer.from(bytes),
    })

  test('writes a PNG and answers its listing entry', async () => {
    const url = start()
    const res = await upload(url, 'ipad/03-new.png')
    expect(res.status).toBe(200)
    expect((await res.json()) as StudioShot).toEqual({
      file: '03-new.png',
      path: '03-new.png',
      width: 8,
      height: 9,
    })
    expect(b64(new Uint8Array(readFileSync(join(rawDir(), 'ipad', '03-new.png'))))).toBe(b64(png(8, 9)))
    const shots = (await (await fetch(`${url}api/shots`)).json()) as StudioShots
    expect(shots.ipad.map((s) => s.path)).toEqual(['03-new.png'])
  })

  test('writes into a locale dir', async () => {
    const url = start()
    const res = await upload(url, 'android/de-DE/02-journal.png')
    expect(((await res.json()) as StudioShot).locale).toBe('de-DE')
    expect(readFileSync(join(rawDir(), 'android', 'de-DE', '02-journal.png')).length).toBeGreaterThan(0)
  })

  test('409 on an existing file unless ?replace=1', async () => {
    const url = start()
    const refused = await upload(url, 'ios/01-home.png')
    expect(refused.status).toBe(409)
    expect(b64(new Uint8Array(readFileSync(join(rawDir(), 'ios', '01-home.png'))))).toBe(b64(png(3, 5)))
    const replaced = await upload(url, 'ios/01-home.png', png(8, 9), '?replace=1')
    expect(replaced.status).toBe(200)
    expect(b64(new Uint8Array(readFileSync(join(rawDir(), 'ios', '01-home.png'))))).toBe(b64(png(8, 9)))
  })

  test('422 for a body that is not a PNG', async () => {
    const url = start()
    expect((await upload(url, 'ios/a.png', 'plain text')).status).toBe(422)
    // A JPEG header: a valid image kit reads, not one the shots take.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 4, 0, 4, 1, 1, 0x11, 0])
    const res = await upload(url, 'ios/a.png', jpeg)
    expect(res.status).toBe(422)
    expect(readdirSync(join(rawDir(), 'ios')).includes('a.png')).toBe(false)
  })

  test('422 for a bad name, 404 for a bad target; nothing outside the raw dir is written', async () => {
    const url = start()
    for (const path of [
      'ios/a.jpg',
      'ios/.hidden.png',
      'ios/a%2fb.png',
      'ios/..%2f..%2fx.png',
      'ios/not a locale!/a.png',
      'ios/a/b/c.png',
      'ios/',
      'ios/a%5cb.png',
    ]) {
      const res = await upload(url, path)
      expect(`${path}: ${res.status}`).toBe(`${path}: 422`)
    }
    expect((await upload(url, 'tablet/a.png')).status).toBe(404)
    expect(readdirSync(dir).sort()).toEqual(['brand', 'font.ttf', 'mark.svg', 'raw', 'secret.txt'])
  })
})

describe('api/asset', () => {
  test('serves the fonts and the brand mark by index with their types', async () => {
    const url = start()
    const font = await fetch(`${url}api/asset/0`)
    expect(font.headers.get('content-type')).toBe('font/ttf')
    expect(await font.text()).toBe('font bytes')
    expect((await fetch(`${url}api/asset/1`)).headers.get('content-type')).toBe('image/svg+xml')
    for (const n of ['2', '-1', '1.5', 'x', '01x', '']) {
      expect((await fetch(`${url}api/asset/${n}`)).status).toBe(404)
    }
  })
})

describe('api/export', () => {
  const post = (url: string, body: unknown) => fetch(`${url}api/export`, { method: 'POST', body: text(body) })

  test('runs the export with the stores and locales and answers its result', async () => {
    const url = start()
    const res = await post(url, { stores: ['apple'], locales: ['en-US'] })
    expect(res.status).toBe(200)
    expect(((await res.json()) as ExportResult).stores).toEqual(['apple'])
    expect(exports).toEqual([{ stores: ['apple'], locales: ['en-US'] }])
    await post(url, { stores: ['apple', 'google'] })
    expect(exports[1]).toEqual({ stores: ['apple', 'google'] })
  })

  test('422 for a bad request, and with the KitError message when the export fails', async () => {
    const url = start()
    expect((await post(url, { stores: [] })).status).toBe(422)
    expect((await post(url, { stores: ['steam'] })).status).toBe(422)
    expect((await post(url, { stores: ['apple'], locales: [1] })).status).toBe(422)
    expect((await fetch(`${url}api/export`, { method: 'POST', body: '{' })).status).toBe(422)
    expect(exports).toEqual([])
    exportError = new KitError('2 raw shots are missing', 'hint', ExitCode.precondition)
    const res = await post(url, { stores: ['google'] })
    expect(res.status).toBe(422)
    expect(((await res.json()) as StudioError).error).toBe('2 raw shots are missing')
  })
})
