import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { KitConfig } from '../../config/schema'
import { CHROME_HINT } from '../chrome'
import { interrupted, onCleanup, trackChild } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { flattenPng, imageInfo } from '../image/png'
import { spawnDetached } from '../proc'
import { chromeArgv, duration, logTail, OPENER_FILE, openerHtml, reason } from './render'
import { CONTENT_TYPES, NO_STORE, notFound } from './server'

/**
 * `kit shots pages`: each HTML page in `shots.pages` is served from the repo root and shot by
 * headless Chrome (`--screenshot`) at its size, then checked and flattened onto its background,
 * because App Store Connect rejects any alpha channel.
 */

type Shots = NonNullable<KitConfig['shots']>
export type PageConfig = NonNullable<Shots['pages']>[number]

/** How long one page may take before Chrome is killed. */
export const PAGE_TIMEOUT_MS = 60_000

/** Virtual time Chrome runs before the shot, so web fonts and images land; `--screenshot` fires on load otherwise. */
export const VIRTUAL_TIME_BUDGET_MS = 5000

/** Where a page lands when neither its `out` nor `--out` says. */
export const DEFAULT_PAGES_DIR = 'build/shots-pages'

export const DEFAULT_SCALE = 2
const DEFAULT_BACKGROUND = '#ffffff'

const MIME: Record<string, string> = {
  ...CONTENT_TYPES,
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
}

/** A page to render, with every default applied and every path resolved. */
export interface PageJob {
  name: string
  /** Absolute HTML file. */
  source: string
  width: number
  height: number
  scale: number
  background: string
  /** Absolute PNG path. */
  target: string
}

export interface RenderedPage {
  name: string
  /** The PNG, relative to the repo root when under it, else absolute. */
  file: string
  width: number
  height: number
}

const inside = (root: string, file: string): boolean => file.startsWith(root + sep)

const repoRel = (root: string, file: string): string =>
  inside(root, file) ? relative(root, file).split(sep).join('/') : file

export const defaultPageFile = (page: Pick<PageConfig, 'name' | 'width' | 'height'>): string =>
  `${page.name}-${page.width}x${page.height}.png`

/** The pages to render: all of `shots.pages`, or the named ones in the order named. Pure. */
export function planPages(
  root: string,
  shots: Shots,
  names: readonly string[],
  outDir: string | undefined,
): PageJob[] {
  const all = shots.pages ?? []
  if (all.length === 0) {
    throw new KitError(
      'shots.pages is empty',
      "Add shots: { pages: [{ name: 'header', file: 'art/header.html', width: 3840, height: 1646 }] } to kit.config.ts",
      ExitCode.config,
    )
  }
  const picked = (names.length === 0 ? all.map((p) => p.name) : [...new Set(names)]).map((name) => {
    const page = all.find((p) => p.name === name)
    if (!page) {
      throw new KitError(
        `No page named "${name}" in shots.pages`,
        `Pages: ${all.map((p) => p.name).join(', ')}`,
        ExitCode.usage,
      )
    }
    return page
  })
  return picked.map((page) => {
    const own = page.out === undefined ? undefined : resolve(root, page.out)
    const file = own ? basename(own) : defaultPageFile(page)
    const dir =
      outDir !== undefined ? resolve(root, outDir) : own ? dirname(own) : resolve(root, DEFAULT_PAGES_DIR)
    return {
      name: page.name,
      source: resolve(root, page.file),
      width: page.width,
      height: page.height,
      scale: page.scale ?? DEFAULT_SCALE,
      background: page.background ?? DEFAULT_BACKGROUND,
      target: join(dir, file),
    }
  })
}

/** `@font-face` rules for `shots.fonts`, served from the same root as the page. */
function fontCss(root: string, prefix: string, shots: Shots): string {
  return (shots.fonts ?? [])
    .map((font) => {
      const url = `${prefix}${encodeURI(repoRel(root, resolve(root, font.file)))}`
      const weight = font.weight ? ` font-weight: ${font.weight};` : ''
      return `@font-face { font-family: "${font.family.replace(/["\\]/g, '')}"; src: url("${url}");${weight} }`
    })
    .join('\n')
}

/** `html` with the `shots.fonts` rules first in its head, so a page needs no `@font-face` of its own. */
export function withFonts(html: string, css: string): string {
  if (css === '') return html
  const style = `<style>${css}</style>`
  const head = /<head[^>]*>/i.exec(html)
  if (!head) return style + html
  const at = head.index + head[0].length
  return html.slice(0, at) + style + html.slice(at)
}

/**
 * Serve the repo root on 127.0.0.1 under a random path token, so a page's relative assets resolve
 * (`../brand/logo.svg`). Dot paths are never served, and nothing outside the root is. HTML gets the
 * `shots.fonts` rules injected.
 */
export function servePages(root: string, shots: Shots): { url: string; stop(): Promise<void> } {
  const token = randomBytes(16).toString('hex')
  const prefix = `/${token}/`
  const css = fontCss(root, prefix, shots)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      if (req.method !== 'GET') return notFound()
      const { pathname } = new URL(req.url)
      if (!pathname.startsWith(prefix)) return notFound()
      let rel: string
      try {
        rel = decodeURIComponent(pathname.slice(prefix.length))
      } catch {
        return notFound()
      }
      if (rel.split('/').some((part) => part.startsWith('.'))) return notFound()
      const file = resolve(root, rel)
      if (!inside(root, file) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return notFound()
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      if (type.startsWith('text/html')) {
        const html = withFonts(readFileSync(file, 'utf8'), css)
        return new Response(html, { headers: { 'content-type': type, ...NO_STORE } })
      }
      return new Response(Bun.file(file), { headers: { 'content-type': type, ...NO_STORE } })
    },
    error: () => new Response('Internal error', { status: 500 }),
  })
  return { url: `http://127.0.0.1:${server.port}${prefix}`, stop: () => server.stop(true) }
}

/** The shot, checked against the page's size and flattened; a failure names the page. */
export function checkedPage(job: PageJob, bytes: Uint8Array): Uint8Array {
  let info: ReturnType<typeof imageInfo>
  try {
    info = imageInfo(bytes)
  } catch (e) {
    throw new KitError(`Chrome wrote a bad image for page ${job.name}: ${reason(e)}`)
  }
  if (info.format !== 'png') {
    throw new KitError(`Chrome wrote a ${info.format} image for page ${job.name}, not a PNG`)
  }
  if (info.width !== job.width || info.height !== job.height) {
    throw new KitError(
      `The PNG for page ${job.name} is ${info.width}x${info.height}`,
      `shots.pages declares ${job.width}x${job.height} at scale ${job.scale}`,
    )
  }
  if (!info.alpha) return bytes
  let flat: Uint8Array
  try {
    flat = flattenPng(bytes, job.background)
  } catch (e) {
    throw new KitError(`Cannot flatten the PNG for page ${job.name}: ${reason(e)}`)
  }
  if (imageInfo(flat).alpha) {
    throw new KitError(`The PNG for page ${job.name} still has an alpha channel after flattening`)
  }
  return flat
}

export interface RenderPagesOptions {
  chrome: string
  root: string
  shots: Shots
  timeoutMs?: number
  step?: (message: string) => void
  verbose?: (message: string) => void
}

/** Shoot every job and write the PNGs, one page at a time; a page's file is written only once it passes its checks. */
export async function renderPages(
  jobs: readonly PageJob[],
  opts: RenderPagesOptions,
): Promise<RenderedPage[]> {
  const timeoutMs = opts.timeoutMs ?? PAGE_TIMEOUT_MS
  for (const job of jobs) {
    if (!inside(opts.root, job.source) || !statSync(job.source, { throwIfNoEntry: false })?.isFile()) {
      throw new KitError(
        `Page ${job.name}: no HTML file at ${job.source}`,
        'shots.pages[].file is relative to the repo root and must stay inside it',
        ExitCode.config,
      )
    }
  }
  const work = mkdtempSync(join(tmpdir(), 'kit-pages-'))
  const server = servePages(opts.root, opts.shots)
  let chrome: Bun.Subprocess | undefined
  const dispose = async (): Promise<void> => {
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      try {
        // Chrome runs as its own process group: renderers and helpers go with it.
        process.kill(-chrome.pid, 'SIGKILL')
      } catch {
        chrome.kill('SIGKILL')
      }
      await chrome.exited
    }
    await server.stop()
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 3 })
    } catch (e) {
      opts.verbose?.(`Could not remove ${work}: ${reason(e)}`)
    }
  }
  const off = onCleanup(dispose)
  const done: RenderedPage[] = []
  try {
    for (const job of jobs) {
      opts.step?.(`Rendering ${job.name} (${job.width}x${job.height})`)
      const dir = join(work, job.name)
      const profile = join(dir, 'profile')
      const shot = join(dir, 'shot.png')
      const log = join(dir, 'chrome.log')
      mkdirSync(profile, { recursive: true })
      // The URL carries the path token; Chrome's argv is readable through `ps`, so the URL goes in a file.
      const opener = join(dir, OPENER_FILE)
      const url = `${server.url}${encodeURI(repoRel(opts.root, job.source))}`
      writeFileSync(opener, openerHtml(url), { mode: 0o600 })
      const flags = [
        `--force-device-scale-factor=${job.scale}`,
        `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
        `--window-size=${job.width / job.scale},${job.height / job.scale}`,
        `--screenshot=${shot}`,
      ]
      try {
        chrome = spawnDetached(chromeArgv(opts.chrome, profile, pathToFileURL(opener).href, flags), log)
      } catch (e) {
        throw new KitError(
          `Cannot start Chrome at ${opts.chrome}: ${reason(e)}`,
          CHROME_HINT,
          ExitCode.precondition,
        )
      }
      trackChild(chrome, true)
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        chrome.exited.then((code) => ({ exited: code })),
        new Promise<'timeout'>((res) => {
          timer = setTimeout(() => res('timeout'), timeoutMs)
        }),
      ])
      clearTimeout(timer)
      if (interrupted()) throw new KitError('Interrupted', undefined, ExitCode.interrupted)
      if (outcome === 'timeout') {
        throw new KitError(
          `Chrome did not finish page ${job.name} within ${duration(timeoutMs)}`,
          logTail(log),
        )
      }
      if (!statSync(shot, { throwIfNoEntry: false })?.size) {
        throw new KitError(
          `Chrome wrote no screenshot of page ${job.name} (exit code ${outcome.exited})`,
          logTail(log) ?? `Ran ${opts.chrome}`,
        )
      }
      const png = checkedPage(job, new Uint8Array(readFileSync(shot)))
      mkdirSync(dirname(job.target), { recursive: true })
      writeFileSync(job.target, png)
      done.push({
        name: job.name,
        file: repoRel(opts.root, job.target),
        width: job.width,
        height: job.height,
      })
    }
  } finally {
    off()
    await dispose()
  }
  return done
}
