import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KitError } from '../../src/lib/errors'
import {
  checkSources,
  type PageJob,
  planPages,
  servedFile,
  servePages,
  withFonts,
} from '../../src/lib/storeshots/pages'

/** The artwork page server, the font injection and the output rules of `kit shots pages`. */

let outer: string
let root: string
let server: ReturnType<typeof servePages>

const shots = (pages: object[]) => ({ pages }) as never
const page = { name: 'header', file: 'art/h.html', width: 200, height: 100 }

beforeAll(() => {
  outer = realpathSync(mkdtempSync(join(tmpdir(), 'kit-pages-unit-')))
  root = join(outer, 'repo')
  mkdirSync(join(root, 'art'), { recursive: true })
  mkdirSync(join(root, '.art'))
  writeFileSync(join(root, 'art/h.html'), '<!doctype html><html><head></head><body>hi</body></html>')
  writeFileSync(join(root, 'art/a.txt'), 'asset')
  writeFileSync(join(root, 'art/we ird#1.txt'), 'odd')
  writeFileSync(join(root, '.env'), 'SECRET')
  writeFileSync(join(root, '.art/x.txt'), 'hidden')
  writeFileSync(join(outer, 'outside.txt'), 'outside')
  symlinkSync('../../outside.txt', join(root, 'art/link.txt'))
  symlinkSync('../.env', join(root, 'art/envlink.txt'))
  symlinkSync('a.txt', join(root, 'art/inner.txt'))
  server = servePages(root, shots([]))
})
afterAll(async () => {
  await server.stop()
  rmSync(outer, { recursive: true, force: true })
})

const get = async (path: string, base = server.url) => {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, text: await res.text() }
}

describe('page server', () => {
  test('serves files under the root and symlinks that stay inside it', async () => {
    expect(await get('art/a.txt')).toEqual({ status: 200, text: 'asset' })
    expect(await get('art/inner.txt')).toEqual({ status: 200, text: 'asset' })
    expect((await get('art/we%20ird%231.txt')).text).toBe('odd')
  })

  test('refuses traversal, encoded traversal and dot segments at every level', async () => {
    for (const path of [
      '../outside.txt',
      '..%2foutside.txt',
      '%2e%2e/outside.txt',
      'art/../../outside.txt',
      '.env',
      '.art/x.txt',
      'art/.%65nv',
      '%2eenv',
    ]) {
      expect(await get(path)).toMatchObject({ status: 404 })
    }
  })

  test('refuses a symlink out of the root and one to a dot file', async () => {
    expect((await get('art/link.txt')).status).toBe(404)
    expect((await get('art/envlink.txt')).status).toBe(404)
  })

  test('refuses another token, a directory, a missing file and a POST', async () => {
    const other = server.url.replace(/[0-9a-f]{32}/, '0'.repeat(32))
    expect((await get('art/a.txt', other)).status).toBe(404)
    expect((await get('art')).status).toBe(404)
    expect((await get('nope.txt')).status).toBe(404)
    expect((await fetch(`${server.url}art/a.txt`, { method: 'POST' })).status).toBe(404)
  })

  test('records every request under the token with its status', async () => {
    const before = server.requests.length
    await get('art/a.txt')
    await get('missing.png')
    expect(server.requests.slice(before)).toEqual([
      { path: 'art/a.txt', status: 200 },
      { path: 'missing.png', status: 404 },
    ])
  })

  test('servedFile returns the real path', () => {
    expect(servedFile(root, 'art/inner.txt')).toBe(join(root, 'art/a.txt'))
    expect(servedFile(root, 'art/link.txt')).toBeUndefined()
  })

  test('adds the shots.fonts rules to HTML, with the path escaped per segment', async () => {
    const fonts = [{ family: 'A"B\nC', file: 'art/we ird#1.txt', weight: '400 800' }]
    const s = servePages(root, { fonts } as never)
    try {
      const { text } = await get('art/h.html', s.url)
      expect(text).toContain('<head><style>@font-face { font-family: "ABC";')
      expect(text).toContain('art/we%20ird%231.txt")')
      expect(text).toContain('font-weight: 400 800;')
    } finally {
      await s.stop()
    }
  })
})

describe('withFonts', () => {
  const css = 'X{}'
  const style = `<style>${css}</style>`

  test('goes first in head, with its attributes', () => {
    expect(withFonts('<html><head lang="x"><title>t</title></head>', css)).toBe(
      `<html><head lang="x">${style}<title>t</title></head>`,
    )
  })

  test('is not fooled by <header> or a commented head', () => {
    expect(withFonts('<html><body><header>h</header></body></html>', css)).toBe(
      `<html>${style}<body><header>h</header></body></html>`,
    )
    expect(withFonts('<!-- <head> --><html><head></head>', css)).toBe(
      `<!-- <head> --><html><head>${style}</head>`,
    )
  })

  test('with no head goes after <html>, else after the doctype, never before it', () => {
    expect(withFonts('<!doctype html><html lang="en"><body></body></html>', css)).toBe(
      `<!doctype html><html lang="en">${style}<body></body></html>`,
    )
    expect(withFonts('<!DOCTYPE html><p>x</p>', css)).toBe(`<!DOCTYPE html>${style}<p>x</p>`)
    expect(withFonts('<p>x</p>', css)).toBe(`${style}<p>x</p>`)
  })

  test('no css, no change', () => {
    expect(withFonts('<p>x</p>', '')).toBe('<p>x</p>')
  })
})

describe('output rules', () => {
  const plan = (pages: object[], names: string[] = [], out?: string) =>
    planPages('/repo', shots(pages), names, out)
  const config = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      expect(e).toBeInstanceOf(KitError)
      return e as KitError
    }
    throw new Error('did not throw')
  }

  test('default and own paths', () => {
    const jobs = plan([page, { ...page, name: 'b', out: 'build/b.png' }])
    expect(jobs.map((j) => j.target)).toEqual([
      '/repo/build/shots-pages/header-200x100.png',
      '/repo/build/b.png',
    ])
    expect(plan([page], [], '/elsewhere')[0]!.target).toBe('/elsewhere/header-200x100.png')
  })

  test('a configured out outside the repo is refused; --out may be anywhere', () => {
    expect(config(() => plan([{ ...page, out: '../x.png' }])).exitCode).toBe(3)
    expect(config(() => plan([{ ...page, out: '/tmp/x.png' }])).message).toContain('outside the repo')
    expect(plan([{ ...page, out: 'x.png' }], [], '../out')[0]!.target).toBe('/out/x.png')
  })

  test('a target that is a page source is refused', () => {
    const e = config(() => plan([page, { ...page, name: 'b', out: 'art/h.html' }]))
    expect(e.message).toContain('source of a page')
    // Even when only the other page is selected.
    expect(config(() => plan([page, { ...page, name: 'b', out: 'art/h.html' }], ['b'])).exitCode).toBe(3)
  })

  test('duplicate targets are refused, basename collisions under --out too', () => {
    expect(
      config(() => plan([page, { ...page, name: 'b', out: 'build/header-200x100.png' }], [], 'build'))
        .message,
    ).toContain('would both write')
    const same = [
      { ...page, name: 'a', out: 'x/p.png' },
      { ...page, name: 'b', out: 'y/p.png' },
    ]
    expect(plan(same)).toHaveLength(2)
    expect(config(() => plan(same, [], 'out')).exitCode).toBe(3)
  })

  test('sources: dot dirs, missing files and links out of the repo are config errors', () => {
    const job = (file: string): PageJob => ({
      ...plan([page])[0]!,
      source: join(root, file),
      target: join(root, 'o.png'),
    })
    mkdirSync(join(root, 'art'), { recursive: true })
    writeFileSync(join(root, '.art/h.html'), '<p>')
    symlinkSync('../../outside.txt', join(root, 'art/out.html'))
    expect(() => checkSources(root, [job('art/h.html')])).not.toThrow()
    expect(config(() => checkSources(root, [job('.art/h.html')])).exitCode).toBe(3)
    expect(config(() => checkSources(root, [job('art/none.html')])).message).toContain('no HTML file')
    expect(config(() => checkSources(root, [job('art/out.html')])).exitCode).toBe(3)
    expect(config(() => checkSources(root, [job('../outside.txt')])).exitCode).toBe(3)
  })
})
