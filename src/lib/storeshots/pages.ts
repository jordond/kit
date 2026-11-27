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
import { flattenPng, imageInfo, stripPngMetadata } from '../image/png'
import { spawnDetached } from '../proc'
import { chromeArgv, duration, logTail, OPENER_FILE, openerHtml, reason } from './render'
import { CONTENT_TYPES, NO_STORE, notFound } from './server'
import { type Viewport, viewportOf, viewportProblem } from './viewport'

/**
 * `kit shots pages`: each HTML page in `shots.pages` is served from the repo root and shot by
 * headless Chrome (`--screenshot`) at its size, then checked and flattened onto its background,
 * because App Store Connect rejects any alpha channel. `kit shots export` shoots the HTML slides
 * of `shots.slides` the same way (`shootPages`), telling each page which set it is drawn for.
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

/**
 * What kit tells the page of an HTML slide: the query string of its URL, `data-kit-*` attributes
 * on `<html>`, and the raw shot as `--kit-shot` and as the `src` of every `<img data-kit-shot>`.
 */
export interface SlideContext {
  /** The set id (`ipad-13`). */
  set: string
  /** `ios`, `ipad` or `android`. */
  target: string
  /** `apple` or `google`. */
  store: string
  locale: string
  /** The slide's name. */
  slide: string
  /** 1-based position in its set. */
  index: number
  /** Absolute path of the raw shot; absent for a slide that shows none. */
  shot?: string
}

/** One HTML file to shoot, with every default applied and every path resolved. */
export interface ShootJob {
  name: string
  /** Absolute HTML file. */
  source: string
  /** Pixel size of the PNG; the page is laid out at width/scale by height/scale. */
  width: number
  height: number
  scale: number
  background: string
  /** How messages name it; default `page <name>`. */
  label?: string
  /** Set for an HTML slide of `kit shots export`. */
  context?: SlideContext
}

/** A page to render, with every default applied and every path resolved. */
export interface PageJob extends ShootJob {
  /** Absolute PNG path. */
  target: string
}

const labelOf = (job: ShootJob): string => job.label ?? `page ${job.name}`
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

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
export function checkSources(root: string, jobs: readonly ShootJob[]): void {
  const real = realpathSync(root)
  for (const job of jobs) {
    const rel = relative(root, job.source)
    const name = capital(labelOf(job))
    const hint = `shots.${job.context ? 'slides' : 'pages'}[].file is relative to the repo root, must stay inside it and not sit under a dot dir`
    if (!inside(root, job.source) || hasDotSegment(rel)) {
      throw configError(`${name}: ${job.source} is outside the repo or under a dot path`, hint)
    }
    if (!statSync(job.source, { throwIfNoEntry: false })?.isFile()) {
      throw configError(`${name}: no HTML file at ${job.source}`, hint)
    }
    if (servedFile(real, relative(root, job.source)) === undefined) {
      throw configError(`${name}: ${job.source} resolves outside the repo or to a dot path`, hint)
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
  return css === '' ? html : withHead(html, `<style>${css}</style>`)
}

/** `html` with `style` (any head markup) put where `withFonts` puts the font rules. */
export function withHead(html: string, style: string): string {
  if (style === '') return html
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

/** The path segment of kit's own routes; no repo file is served from under it. */
const KIT_ROUTE = '__kit'

/** `<` cannot end a script early: JSON leaves it as is, so it is escaped here. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

/**
 * Reports the top document's viewport to the server, now and at every resize: Chrome brings the
 * window to its final size just before the screenshot. Synchronous, so the report is in before
 * the capture.
 */
const viewportScript = (prefix: string): string =>
  `<script>(()=>{if(window.top!==window)return;const r=()=>{try{const x=new XMLHttpRequest();x.open('GET',${scriptJson(`${prefix}${KIT_ROUTE}/viewport`)}+'?w='+innerWidth+'&h='+innerHeight,false);x.send()}catch{}};r();addEventListener('resize',r)})()</script>`

const CONTEXT_KEYS = ['set', 'target', 'store', 'locale', 'slide', 'index'] as const

/** `data-kit-shot` on an `<img>`: the tag gets the raw shot as its `src`, and loses any `srcset`. */
const SHOT_IMG = /<img\b(?=[^>]*\sdata-kit-shot(?![\w-]))[^>]*>/gi
const SRC_ATTR = /\s(?:src|srcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

/**
 * The slide's HTML as the page is told about its set: `data-kit-*` on `<html>` (set by a script
 * that runs before the body is parsed), `--kit-shot` on `:root`, and the shot as the `src` of every
 * `<img data-kit-shot>`. `shot` is the URL path the server exposes the raw shot at.
 */
export function withContext(html: string, query: URLSearchParams, shot: string | undefined): string {
  const data: Record<string, string> = {}
  for (const key of CONTEXT_KEYS) {
    const value = query.get(key)
    if (value !== null) data[`kit${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value
  }
  if (shot !== undefined) data.kitShot = shot
  const style = shot === undefined ? '' : `<style>:root{--kit-shot:url("${shot}")}</style>`
  const script = `<script>Object.assign(document.documentElement.dataset,${scriptJson(data)})</script>`
  const filled =
    shot === undefined
      ? html
      : html.replace(SHOT_IMG, (tag) => `<img src="${shot}"${tag.slice(4).replace(SRC_ATTR, '')}`)
  return withHead(filled, style + script)
}

export interface PageServer {
  /** `http://127.0.0.1:<port>/<token>/` */
  url: string
  /** Every request for a file under the token, in order. */
  requests: ServedRequest[]
  /** Serve `file` (absolute, inside the repo or not) and give the URL path it is at. */
  expose(file: string): string
  /** The viewport the page last reported, since `forgetViewport`. */
  viewport(): Viewport | undefined
  forgetViewport(): void
  stop(): Promise<void>
}

/**
 * Serve the repo root on 127.0.0.1 under a random path token, so a page's relative assets resolve
 * (`../brand/logo.svg`). Any non-dot file under the repo can be read by the page: dot paths, symlinks
 * that lead outside the root or to a dot path, and everything else are 404. HTML gets the
 * `shots.fonts` rules and the viewport report injected, and a slide's page its context (a request
 * with `set` in its query). `root` is the real path of the repo root.
 */
export function servePages(root: string, shots: Shots): PageServer {
  const token = randomBytes(16).toString('hex')
  const prefix = `/${token}/`
  const css = fontCss(root, prefix, shots)
  const head = css === '' ? '' : `<style>${css}</style>`
  const requests: ServedRequest[] = []
  const exposed: string[] = []
  let viewport: Viewport | undefined
  const file = (path: string, type?: string): Response =>
    new Response(Bun.file(path), {
      headers: {
        'content-type': type ?? MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        ...NO_STORE,
      },
    })
  const kitRoute = (rel: string, query: URLSearchParams): Response => {
    if (rel === 'viewport') {
      const [width, height] = [Number(query.get('w')), Number(query.get('h'))]
      if (Number.isFinite(width) && Number.isFinite(height)) viewport = { width, height }
      return new Response(null, { status: 204, headers: NO_STORE })
    }
    const at = /^shot\/(\d+)$/.exec(rel)?.[1]
    const shot = at === undefined ? undefined : exposed[Number(at)]
    return shot !== undefined && statSync(shot, { throwIfNoEntry: false })?.isFile() ? file(shot) : notFound()
  }
  const answer = (req: Request): Response => {
    if (req.method !== 'GET') return notFound()
    const { pathname, searchParams } = new URL(req.url)
    if (!pathname.startsWith(prefix)) return notFound()
    let rel: string
    try {
      rel = decodeURIComponent(pathname.slice(prefix.length))
    } catch {
      return notFound()
    }
    if (rel.startsWith(`${KIT_ROUTE}/`)) return kitRoute(rel.slice(KIT_ROUTE.length + 1), searchParams)
    const served = servedFile(root, rel)
    if (served === undefined) return notFound()
    const type = MIME[extname(served).toLowerCase()] ?? 'application/octet-stream'
    if (!type.startsWith('text/html')) return file(served, type)
    let html = withHead(readFileSync(served, 'utf8'), head + viewportScript(prefix))
    if (searchParams.has('set')) {
      // Only a path this server made is put into the page.
      const shot = searchParams.get('shot') ?? ''
      const known = new RegExp(`^${prefix}${KIT_ROUTE}/shot/\\d+$`).test(shot)
      html = withContext(html, searchParams, known ? shot : undefined)
    }
    return new Response(html, { headers: { 'content-type': type, ...NO_STORE } })
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const response = answer(req)
      const { pathname } = new URL(req.url)
      if (pathname.startsWith(prefix) && pathname !== `${prefix}${KIT_ROUTE}/viewport`)
        requests.push({ path: pathname.slice(prefix.length), status: response.status })
      return response
    },
    error: () => new Response('Internal error', { status: 500 }),
  })
  return {
    url: `http://127.0.0.1:${server.port}${prefix}`,
    requests,
    expose: (path) => `${prefix}${KIT_ROUTE}/shot/${exposed.push(path) - 1}`,
    viewport: () => viewport,
    forgetViewport: () => {
      viewport = undefined
    },
    stop: () => server.stop(true),
  }
}

/** The shot, checked against the page's size and flattened; a failure names the page. */
export function checkedPage(job: ShootJob, bytes: Uint8Array): Uint8Array {
  const name = labelOf(job)
  let info: ReturnType<typeof imageInfo>
  try {
    info = imageInfo(bytes)
  } catch (e) {
    throw new KitError(`Chrome wrote a bad image for ${name}: ${reason(e)}`)
  }
  if (info.format !== 'png') {
    throw new KitError(`Chrome wrote a ${info.format} image for ${name}, not a PNG`)
  }
  if (info.width !== job.width || info.height !== job.height) {
    throw new KitError(
      `The PNG for ${name} is ${info.width}x${info.height}`,
      job.context
        ? `The ${job.context.set} set is ${job.width}x${job.height}, shot at scale ${job.scale}`
        : `shots.pages declares ${job.width}x${job.height} at scale ${job.scale}`,
    )
  }
  // No date or text chunk: a run that changes nothing writes the same bytes.
  if (!info.alpha) return stripPngMetadata(bytes)
  let flat: Uint8Array
  try {
    flat = flattenPng(bytes, job.background)
  } catch (e) {
    throw new KitError(`Cannot flatten the PNG for ${name}: ${reason(e)}`)
  }
  if (imageInfo(flat).alpha) {
    throw new KitError(`The PNG for ${name} still has an alpha channel after flattening`)
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
  /** A page whose layout size could not be checked. */
  warn?: (message: string) => void
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
  const done: RenderedPage[] = []
  await shootPages(jobs, opts, (job, png) => {
    writeAtomic(job.target, png)
    done.push({ name: job.name, file: repoRel(opts.root, job.target), width: job.width, height: job.height })
  })
  return done
}

/** The query string a slide's page is opened with: its context, the shot as a URL path of `server`. */
function contextQuery(server: PageServer, context: SlideContext | undefined): string {
  if (!context) return ''
  const { shot, index, ...rest } = context
  const query = new URLSearchParams({ ...rest, index: String(index) })
  if (shot !== undefined) query.set('shot', server.expose(shot))
  return `?${query}`
}

/**
 * Shoot every job in headless Chrome, one at a time, handing each checked PNG (exact size, no
 * alpha, no date chunk) to `sink`. A page that asks for a file the server refuses, or that Chrome
 * lays out at another size than `width / scale` by `height / scale`, fails the run.
 */
export async function shootPages<J extends ShootJob>(
  jobs: readonly J[],
  opts: RenderPagesOptions,
  sink: (job: J, png: Uint8Array) => void,
): Promise<void> {
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
  try {
    for (const [i, job] of jobs.entries()) {
      const name = labelOf(job)
      opts.step?.(`Rendering ${job.label ?? job.name} (${job.width}x${job.height})`)
      const dir = join(work, String(i))
      const profile = join(dir, 'profile')
      const shot = join(dir, 'shot.png')
      const log = join(dir, 'chrome.log')
      mkdirSync(profile, { recursive: true })
      // The URL carries the path token; Chrome's argv is readable through `ps`, so the URL goes in a file.
      const opener = join(dir, OPENER_FILE)
      const path = relative(root, realpathSync(job.source)).split(sep).map(encodeURIComponent).join('/')
      writeFileSync(opener, openerHtml(`${server.url}${path}${contextQuery(server, job.context)}`), {
        mode: 0o600,
      })
      server.forgetViewport()
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
        throw new KitError(`Chrome did not finish ${name} within ${duration(timeoutMs)}`, logTail(log))
      }
      const refused = server.requests.slice(seen).find((r) => r.status < 200 || r.status >= 300)
      if (refused) {
        throw new KitError(
          `${capital(name)} requested /${refused.path}, which the server answered ${refused.status}`,
          'Only files under the repo root are served, and not dot files or links that leave it',
        )
      }
      if (!statSync(shot, { throwIfNoEntry: false })?.size) {
        throw new KitError(
          `Chrome wrote no screenshot of ${name} (exit code ${outcome.exited})`,
          logTail(log) ?? `Ran ${opts.chrome}`,
        )
      }
      const seenViewport = server.viewport()
      if (seenViewport === undefined && job.context) {
        // The same script-less page was not told its set either.
        throw new KitError(
          `${capital(name)} did not report its viewport`,
          'kit adds a script to the page that reports it and sets data-kit-*; a Content-Security-Policy that blocks inline scripts stops both',
        )
      }
      if (seenViewport === undefined) {
        opts.warn?.(`${capital(name)} did not report its viewport, so its layout size is unchecked`)
      } else {
        const problem = viewportProblem(viewportOf(job.width, job.height, job.scale), seenViewport)
        if (problem) throw new KitError(`${capital(name)} ${problem.message}`, problem.hint)
      }
      sink(job, checkedPage(job, new Uint8Array(readFileSync(shot))))
    }
  } finally {
    opts.requests?.push(...server.requests)
    off()
    await dispose()
  }
}
