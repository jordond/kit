import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { imageInfo } from '../../src/lib/image/png'
import type {
  StudioError,
  StudioProjectFile,
  StudioSaved,
  StudioSession,
  StudioShots,
} from '../../src/lib/storeshots/studio-api'
import type { ExportResult, ProjectV1 } from '../../src/lib/storeshots/types'
import { type FakeChrome, fakeChrome } from '../helpers/fake-chrome'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit shots studio --no-open` against a copy of the shots-app fixture, driven through its API. */

let f: Fixture | undefined
let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
let chrome: FakeChrome
const savedEnv = { KIT_CHROME: process.env.KIT_CHROME, CHROME_PATH: process.env.CHROME_PATH }

afterEach(async () => {
  proc?.kill('SIGINT')
  await proc?.exited
  proc = undefined
  f?.cleanup()
  f = undefined
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Start the command and wait for the URL it prints. `fixture.spawn` inherits this process's env. */
async function start(args: string[] = [], edit?: (dir: string) => void): Promise<string> {
  f = fixture('shots-app', [])
  edit?.(f.dir)
  chrome = fakeChrome(f.dir)
  process.env.KIT_CHROME = chrome.bin
  process.env.CHROME_PATH = ''
  proc = f.spawn(['shots', 'studio', '--no-open', ...args])
  const reader = proc.stderr.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  const found = async (): Promise<string> => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`kit exited before it printed a URL:\n${seen}`)
      seen += decoder.decode(value)
      const url = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\//.exec(seen)?.[0]
      if (url) return url
    }
  }
  return await found()
}

describe('kit shots studio', () => {
  test('the session carries the repo presets and the palette, as a list or with names', async () => {
    const withShots = (extra: string) => (dir: string) => {
      const file = join(dir, 'kit.config.ts')
      const text = readFileSync(file, 'utf8')
      writeFileSync(
        file,
        text.replace("project: 'brand/studio.json',", `project: 'brand/studio.json', ${extra}`),
      )
    }
    let url = await start(
      [],
      withShots(
        "presets: { sand: { background: { primaryColor: '#f4ecd8' } } }, palette: ['#2c1e14', '#f4ecd8'],",
      ),
    )
    let session = (await (await fetch(`${url}api/session`)).json()) as StudioSession
    expect(session.presets).toEqual({ sand: { background: { primaryColor: '#f4ecd8' } } })
    expect(session.palette).toEqual([{ color: '#2c1e14' }, { color: '#f4ecd8' }])
    proc?.kill('SIGINT')
    await proc?.exited
    f?.cleanup()
    url = await start([], withShots("palette: { ink: '#2c1e14' },"))
    session = (await (await fetch(`${url}api/session`)).json()) as StudioSession
    expect(session.presets).toEqual({})
    expect(session.palette).toEqual([{ name: 'ink', color: '#2c1e14' }])
  }, 30_000)

  test('serves the session, the project and a raw shot', async () => {
    const url = await start()
    const session = (await (await fetch(`${url}api/session`)).json()) as StudioSession
    expect(session.projectPath).toBe('brand/studio.json')
    expect(session.rawPath).toBe('maestro/screenshots')
    expect(session.sets.ios).toMatchObject({ id: 'iphone-6.9', store: 'apple', width: 1320, height: 2868 })
    expect(session.locales.apple).toEqual(['en-US', 'fr-FR'])
    expect(session.fonts).toEqual([{ family: 'Kit Fixture', url: 'api/asset/0', weight: '400 800' }])
    expect(session.brand).toMatchObject({ mark: 'api/asset/1', wordmark: 'shots' })

    const file = (await (await fetch(`${url}api/project`)).json()) as StudioProjectFile
    expect(file.project.version).toBe(1)
    expect(file.hash).toMatch(/^[0-9a-f]{64}$/)

    const shots = (await (await fetch(`${url}api/shots`)).json()) as StudioShots
    const home = shots.ios.find((shot) => shot.path === 'home.png')
    expect(home).toBeDefined()
    const png = new Uint8Array(await (await fetch(`${url}api/shot/ios/home.png`)).arrayBuffer())
    expect(imageInfo(png)).toMatchObject({ width: home!.width, height: home!.height })

    expect((await fetch(`${url}api/asset/0`)).headers.get('content-type')).toBe('font/ttf')
    // Without a built editor the page is the placeholder; the API does not need it.
    expect((await fetch(url)).status).toBe(200)
    expect((await fetch(new URL(url).origin + '/')).status).toBe(404)
  })

  test('saves a change to the file and refuses a stale hash', async () => {
    const url = await start()
    const file = (await (await fetch(`${url}api/project`)).json()) as StudioProjectFile
    const project = file.project as ProjectV1
    project.slides[0]!.headline.text = 'Edited in the studio'
    const res = await fetch(`${url}api/project`, {
      method: 'PUT',
      body: JSON.stringify({ project, hash: file.hash }),
    })
    expect(res.status).toBe(200)
    const { hash } = (await res.json()) as StudioSaved
    const onDisk = JSON.parse(readFileSync(join(f!.dir, 'brand/studio.json'), 'utf8')) as ProjectV1
    expect(onDisk.slides[0]!.headline.text).toBe('Edited in the studio')
    expect(hash).not.toBe(file.hash)

    const stale = await fetch(`${url}api/project`, {
      method: 'PUT',
      body: JSON.stringify({ project, hash: file.hash }),
    })
    expect(stale.status).toBe(409)
  })

  test('exports through the export pipeline, with the fake Chrome', async () => {
    const url = await start()
    const res = await fetch(`${url}api/export`, {
      method: 'POST',
      body: JSON.stringify({ stores: ['apple', 'google'], locales: ['en-US'] }),
    })
    expect(res.status).toBe(200)
    const result = (await res.json()) as ExportResult
    expect(result.dryRun).toBe(false)
    expect(result.written.length).toBeGreaterThan(0)
    for (const shot of result.written) expect(existsSync(join(f!.dir, shot.file))).toBe(true)
    expect(chrome.runs().length).toBe(1)
  })

  test('an export that cannot run is a 422 with its message', async () => {
    const url = await start()
    const res = await fetch(`${url}api/export`, {
      method: 'POST',
      body: JSON.stringify({ stores: ['apple'], locales: ['xx-XX'] }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as StudioError).error).toContain('xx-XX')
  })

  test('--port takes the port, and a bad one is a usage error', async () => {
    const free = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = free.port
    await free.stop(true)
    const url = await start(['--port', String(port)])
    expect(new URL(url).port).toBe(String(port))
    await proc!.kill('SIGINT')
    await proc!.exited
    const bad = await f!.kit(['shots', 'studio', '--no-open', '--port', '70000'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('--port 70000 is not a port')
  })
})
