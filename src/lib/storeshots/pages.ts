import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

/** One request the page server answered, under its token: the path after it, and the status. */
export interface ServedRequest {
  path: string
  status: number
}

const inside = (root: string, file: string): boolean => file.startsWith(root + sep)

const repoRel = (root: string, file: string): string =>
  inside(root, file) ? relative(root, file).split(sep).join('/') : file

/** A path with a dot segment (`.git`, `.env`, `..`) in it. */
const hasDotSegment = (path: string): boolean => path.split(/[\\/]/).some((part) => part.startsWith('.'))

export const defaultPageFile = (page: Pick<PageConfig, 'name' | 'width' | 'height'>): string =>
  `${page.name}-${page.width}x${page.height}.png`

const configError = (message: string, hint?: string): KitError => new KitError(message, hint, ExitCode.config)

/**
 * The pages to render: all of `shots.pages`, or the named ones in the order named. Pure.
 *
 * A page's own `out` must stay inside the repo; `--out` (`outDir`) may name any dir. No two pages
 * may write the same file, and no page may write over the source of any page.
 */
export function planPages(
  root: string,
  shots: Shots,
  names: readonly string[],
  outDir: string | undefined,
): PageJob[] {
  const all = shots.pages ?? []
  if (all.length === 0) {
    throw configError(
      'shots.pages is empty',
      "Add shots: { pages: [{ name: 'header', file: 'art/header.html', width: 3840, height: 1646 }] } to kit.config.ts",
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
  const sources = new Set(all.map((p) => resolve(root, p.file)))
  const targets = new Map<string, string>()
  return picked.map((page) => {
    const own = page.out === undefined ? undefined : resolve(root, page.out)
    if (own !== undefined && !inside(root, own)) {
      throw configError(
        `Page ${page.name}: out ${page.out} is outside the repo`,
        'Use a path inside the repo, or pass --out <dir>',
      )
    }
    const file = own ? basename(own) : defaultPageFile(page)
    const dir =
      outDir !== undefined ? resolve(root, outDir) : own ? dirname(own) : resolve(root, DEFAULT_PAGES_DIR)
    const target = join(dir, file)
    if (sources.has(target)) {
      throw configError(
        `Page ${page.name}: ${repoRel(root, target)} is the source of a page`,
        'It would overwrite the HTML',
      )
    }
    const other = targets.get(target)
    if (other !== undefined) {
      throw configError(
        `Pages ${other} and ${page.name} would both write ${repoRel(root, target)}`,
        'Give them different names or out paths',
      )
    }
    targets.set(target, page.name)
    return {
      name: page.name,
      source: resolve(root, page.file),
      width: page.width,
      height: page.height,
      scale: page.scale ?? DEFAULT_SCALE,
      background: page.background ?? DEFAULT_BACKGROUND,
      target,
    }
  })
}

/**
 * The real file a served path names, or undefined: no dot segment in the request or in the real
 * path, and the real path (symlinks resolved) is a file inside the real root. `root` is real.
 */
export function servedFile(root: string, rel: string): string | undefined {
  if (hasDotSegment(rel)) return undefined
  const file = resolve(root, rel)
  if (!inside(root, file)) return undefined
  let real: string
  try {
    real = realpathSync(file)
  } catch {
    return undefined
  }
  if (!inside(root, real) || hasDotSegment(relative(root, real))) return undefined
  return statSync(real).isFile() ? real : undefined
}

/** Refuse (exit 3) a page whose HTML is missing, under a dot dir, or reaches outside the repo by a link. */
export function checkSources(root: string, jobs: readonly PageJob[]): void {
  const real = realpathSync(root)
  for (const job of jobs) {
    const rel = relative(root, job.source)
    const hint =
      'shots.pages[].file is relative to the repo root, must stay inside it and not sit under a dot dir'
    if (!inside(root, job.source) || hasDotSegment(rel)) {
      throw configError(`Page ${job.name}: ${job.source} is outside the repo or under a dot path`, hint)
    }
    if (!statSync(job.source, { throwIfNoEntry: false })?.isFile()) {
      throw configError(`Page ${job.name}: no HTML file at ${job.source}`, hint)
    }
    if (servedFile(real, relative(root, job.source)) === undefined) {
      throw configError(`Page ${job.name}: ${job.source} resolves outside the repo or to a dot path`, hint)
    }
  }
}

/** `font-weight` values kit passes into CSS: words and numbers only. */
const WEIGHT = /^[\w .%-]+$/

/** `@font-face` rules for `shots.fonts`, served from the same root as the page. */
function fontCss(root: string, prefix: string, shots: Shots): string {
  return (shots.fonts ?? [])
    .map((font) => {
      const url = `${prefix}${repoRel(root, resolve(root, font.file)).split('/').map(encodeURIComponent).join('/')}`
      const weight = font.weight && WEIGHT.test(font.weight) ? ` font-weight: ${font.weight};` : ''
      // Quotes, backslashes and control characters would end the CSS string early.
      const family = font.family
        .split('')
        .filter((c) => c !== '"' && c !== '\\' && c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
        .join('')
      return `@font-face { font-family: "${family}"; src: url("${url}");${weight} }`
    })
    .join('\n')
}

/**
 * `html` with the `shots.fonts` rules in it, so a page needs no `@font-face` of its own: first in
 * `<head>`, else after `<html>`, else after the doctype, else at the start. Comments are skipped, and
 * `<header>` is not `<head>`. The rules never go before the doctype, which would force quirks mode.
 */
export function withFonts(html: string, css: string): string {
  if (css === '') return html
  const style = `<style>${css}</style>`
  // Same length as `html`, so a match index is an index of `html`.
  const masked = html.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length))
  for (const tag of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const found = tag.exec(masked)
    if (found) {
      const at = found.index + found[0].length
      return html.slice(0, at) + style + html.slice(at)
    }
  }
  return style + html
}

export interface PageServer {
  /** `http://127.0.0.1:<port>/<token>/` */
  url: string
  /** Every request under the token, in order. */
  requests: ServedRequest[]
  stop(): Promise<void>
}

/**
 * Serve the repo root on 127.0.0.1 under a random path token, so a page's relative assets resolve
 * (`../brand/logo.svg`). Any non-dot file under the repo can be read by the page: dot paths, symlinks
 * that lead outside the root or to a dot path, and everything else are 404. HTML gets the
 * `shots.fonts` rules injected. `root` is the real path of the repo root.
 */
export function servePages(root: string, shots: Shots): PageServer {
  const token = randomBytes(16).toString('hex')
  const prefix = `/${token}/`
  const css = fontCss(root, prefix, shots)
  const requests: ServedRequest[] = []
  const answer = (req: Request): Response => {
    if (req.method !== 'GET') return notFound()
    const { pathname } = new URL(req.url)
    if (!pathname.startsWith(prefix)) return notFound()
    let rel: string
    try {
      rel = decodeURIComponent(pathname.slice(prefix.length))
    } catch {
      return notFound()
    }
    const file = servedFile(root, rel)
    if (file === undefined) return notFound()
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    if (type.startsWith('text/html')) {
      const html = withFonts(readFileSync(file, 'utf8'), css)
      return new Response(html, { headers: { 'content-type': type, ...NO_STORE } })
    }
    return new Response(Bun.file(file), { headers: { 'content-type': type, ...NO_STORE } })
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const response = answer(req)
      const { pathname } = new URL(req.url)
      if (pathname.startsWith(prefix))
        requests.push({ path: pathname.slice(prefix.length), status: response.status })
      return response
    },
    error: () => new Response('Internal error', { status: 500 }),
  })
  return { url: `http://127.0.0.1:${server.port}${prefix}`, requests, stop: () => server.stop(true) }
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

/** Write through a temp file and a rename, so a failed write never leaves half a PNG at the target. */
function writeAtomic(target: string, bytes: Uint8Array): void {
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temp, bytes)
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
}

export interface RenderPagesOptions {
  chrome: string
  root: string
  shots: Shots
  timeoutMs?: number
  step?: (message: string) => void
  verbose?: (message: string) => void
  /** Filled with every request the page server answered, for tests. */
  requests?: ServedRequest[]
}

/** Kill Chrome's whole process group, the leader gone or not. */
function killGroup(chrome: Bun.Subprocess | undefined): void {
  if (chrome === undefined) return
  try {
    process.kill(-chrome.pid, 'SIGKILL')
  } catch {
    // ESRCH: nothing of the group is left.
  }
}

/** Shoot every job and write the PNGs, one page at a time; a page's file is written only once it passes its checks. */
export async function renderPages(
  jobs: readonly PageJob[],
  opts: RenderPagesOptions,
): Promise<RenderedPage[]> {
  const timeoutMs = opts.timeoutMs ?? PAGE_TIMEOUT_MS
  checkSources(opts.root, jobs)
  const root = realpathSync(opts.root)
  const work = mkdtempSync(join(tmpdir(), 'kit-pages-'))
  const server = servePages(root, opts.shots)
  let chrome: Bun.Subprocess | undefined
  const dispose = async (): Promise<void> => {
    killGroup(chrome)
    if (chrome) await chrome.exited
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
      const path = relative(root, realpathSync(job.source)).split(sep).map(encodeURIComponent).join('/')
      writeFileSync(opener, openerHtml(`${server.url}${path}`), { mode: 0o600 })
      const flags = [
        `--force-device-scale-factor=${job.scale}`,
        `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
        `--window-size=${job.width / job.scale},${job.height / job.scale}`,
        `--screenshot=${shot}`,
      ]
      const seen = server.requests.length
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
      // The leader may be gone with helpers still running.
      killGroup(chrome)
      if (interrupted()) throw new KitError('Interrupted', undefined, ExitCode.interrupted)
      if (outcome === 'timeout') {
        throw new KitError(
          `Chrome did not finish page ${job.name} within ${duration(timeoutMs)}`,
          logTail(log),
        )
      }
      const refused = server.requests.slice(seen).find((r) => r.status < 200 || r.status >= 300)
      if (refused) {
        throw new KitError(
          `Page ${job.name} requested /${refused.path}, which the server answered ${refused.status}`,
          'Only files under the repo root are served, and not dot files or links that leave it',
        )
      }
      if (!statSync(shot, { throwIfNoEntry: false })?.size) {
        throw new KitError(
          `Chrome wrote no screenshot of page ${job.name} (exit code ${outcome.exited})`,
          logTail(log) ?? `Ran ${opts.chrome}`,
        )
      }
      const png = checkedPage(job, new Uint8Array(readFileSync(shot)))
      writeAtomic(job.target, png)
      done.push({
        name: job.name,
        file: repoRel(opts.root, job.target),
        width: job.width,
        height: job.height,
      })
    }
  } finally {
    opts.requests?.push(...server.requests)
    off()
    await dispose()
  }
  return done
}
