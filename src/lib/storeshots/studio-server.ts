import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { KitError } from '../errors'
import { imageInfo } from '../image/png'
import type { DeviceTarget } from '../devices'
import { isLocale } from './plan'
import { projectSchema } from './project'
import { body, CONTENT_TYPES, file, NO_STORE, notFound } from './server'
import { STORE_TARGETS, STORES } from './sizes'
import type {
  StudioError,
  StudioExportRequest,
  StudioExportResult,
  StudioProjectFile,
  StudioSave,
  StudioSaved,
  StudioSession,
  StudioShot,
  StudioShots,
} from './studio-api'
import { statOrSkip } from './write'

/**
 * The studio's HTTP side: the built editor plus the API documented in `studio-api.ts`. Hardened
 * like `server.ts` (`127.0.0.1`, a random path token on every route, `no-store`); see there.
 */

export interface StudioServerOptions {
  /** Answers `GET api/session`. */
  session: StudioSession
  /** The absolute project file (`shots.project`). */
  projectFile: string
  /** The absolute raw dir: `<target>/[<locale>/]<shot>.png` under it. */
  rawDir: string
  /** The files behind `api/asset/<n>`: `ExportPlan.assets`, in order. */
  assets: readonly string[]
  /** Runs one export. A KitError it throws is a 422; the server runs one at a time. */
  runExport: (request: StudioExportRequest) => Promise<StudioExportResult>
  /** The built editor (`dist/shots-editor`); absent, or without an `index.html`, serves a placeholder. */
  editorDir?: string
  /** `--port`; default: the OS picks one. */
  port?: number
}

export interface StudioServer {
  /** `http://127.0.0.1:<port>/<token>/`. */
  url: string
  /** Close the listener and drop open connections. Safe to call twice. */
  stop(): Promise<void>
}

const EDITOR_TYPES: Record<string, string> = {
  ...CONTENT_TYPES,
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** The page served when no editor is built: the API works without it. */
const PLACEHOLDER = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>kit shots studio</title>
<style>body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }</style>
</head>
<body>
<h1>kit shots studio</h1>
<p>The editor is not built. The API is running: <a href="api/session">api/session</a>.</p>
<p>In a source checkout of kit, build it with <code>bun run build</code>, or work on it with <code>bun run dev:studio</code>.
An installed kit ships it as <code>dist/shots-editor/</code>; reinstall kit if that is missing.</p>
</body>
</html>
`

/** The largest request body: a raw shot upload or a project. */
const MAX_BODY = 64 * 1024 * 1024
/** A file name the server writes: one segment, no leading dot, `.png`. */
const SHOT_NAME = /^[^/\\\0:*?"<>|]{1,200}\.png$/i

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE },
  })
}

const fail = (status: number, error: string, issues?: string[]): Response =>
  json(issues ? ({ error, issues } satisfies StudioError) : ({ error } satisfies StudioError), status)

/** The URL path's segments, decoded; undefined when one is not valid UTF-8 percent-encoding. */
function segments(route: string): string[] | undefined {
  try {
    return route.split('/').map((part) => decodeURIComponent(part))
  } catch {
    return undefined
  }
}

const TARGETS: readonly string[] = [...STORE_TARGETS.apple, ...STORE_TARGETS.google]
const isTarget = (value: string): value is DeviceTarget => TARGETS.includes(value)

/** Whether a locale dir or file name is safe to join under a target dir. */
const plainName = (name: string): boolean => name !== '' && !name.startsWith('.') && !/[/\\\0]/.test(name)

/**
 * The PNGs of `<raw>/<target>`: the dir's own, then those of each locale dir. Never a path the
 * request supplied; the shot routes look a request up here.
 */
function listShots(rawDir: string, target: string, withSize: boolean): StudioShot[] {
  const dir = join(rawDir, target)
  if (!statOrSkip(dir)?.isDirectory()) return []
  const shots: StudioShot[] = []
  const add = (at: string, name: string, locale?: string): void => {
    if (!name.toLowerCase().endsWith('.png') || name.startsWith('.')) return
    if (!statOrSkip(join(at, name))?.isFile()) return
    let size = { width: 0, height: 0 }
    if (withSize) {
      try {
        const info = imageInfo(new Uint8Array(readFileSync(join(at, name))))
        size = { width: info.width, height: info.height }
      } catch {
        return // not a PNG kit can read: the editor cannot draw it either
      }
    }
    shots.push({
      file: name,
      path: locale === undefined ? name : `${locale}/${name}`,
      ...(locale === undefined ? {} : { locale }),
      ...size,
    })
  }
  const entries = readdirSync(dir).sort()
  for (const name of entries) add(dir, name)
  for (const name of entries) {
    if (isLocale(name) && statOrSkip(join(dir, name))?.isDirectory()) {
      for (const inner of readdirSync(join(dir, name)).sort()) add(join(dir, name), inner, name)
    }
  }
  return shots
}

/** Write `bytes` to `file` through a temp file in the same dir, so a reader never sees half a file. */
function writeAtomic(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, bytes)
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Serve `route` from the built editor; never a path outside `dir`. */
async function editorFile(dir: string, route: string): Promise<Response> {
  const parts = segments(route)
  if (!parts || parts.some((part) => part === '' || part === '.' || part === '..' || /[\\\0]/.test(part))) {
    return notFound()
  }
  const root = resolve(dir)
  const path = resolve(root, ...parts)
  if (!path.startsWith(root + sep)) return notFound()
  return await file(path, EDITOR_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream')
}

/** Start serving the studio. The caller stops the server. */
export function serveStudio(opts: StudioServerOptions): StudioServer {
  const token = randomBytes(16).toString('hex')
  const prefix = `/${token}/`
  const { session, projectFile, rawDir } = opts
  const hasEditor = opts.editorDir !== undefined && existsSync(join(opts.editorDir, 'index.html'))
  let saving: Promise<unknown> = Promise.resolve()
  let exporting = false

  const getProject = (): Response => {
    if (!existsSync(projectFile)) return fail(404, `No project file at ${session.projectPath}`)
    const bytes = readFileSync(projectFile)
    let value: unknown
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch (e) {
      return fail(422, `${session.projectPath} is not JSON (${e instanceof Error ? e.message : String(e)})`)
    }
    const parsed = projectSchema.safeParse(value)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      return fail(422, `${session.projectPath} is not a valid project`, issues)
    }
    return json({ project: parsed.data, hash: sha256(bytes) } as StudioProjectFile)
  }

  const putProject = (save: unknown): Response => {
    const input = save as Partial<StudioSave> | null
    if (typeof input !== 'object' || input === null || !('project' in input)) {
      return fail(422, 'The body is not { project, hash }')
    }
    if (input.hash !== null && typeof input.hash !== 'string') {
      return fail(422, 'hash is a string, or null to create the file')
    }
    const parsed = projectSchema.safeParse(input.project)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      return fail(422, 'The project is not valid', issues)
    }
    const exists = existsSync(projectFile)
    if (input.hash === null && exists) return fail(409, `${session.projectPath} exists already`)
    if (typeof input.hash === 'string') {
      if (!exists) return fail(409, `${session.projectPath} is gone from disk`)
      if (sha256(readFileSync(projectFile)) !== input.hash) {
        return fail(409, `${session.projectPath} changed on disk since it was loaded`)
      }
    }
    const text = `${JSON.stringify(parsed.data, null, 2)}\n`
    writeAtomic(projectFile, text)
    return json({ hash: sha256(text) } satisfies StudioSaved)
  }

  const getShot = async (route: string): Promise<Response> => {
    const parts = segments(route)
    const target = parts?.[0]
    if (!parts || target === undefined || !isTarget(target) || parts.length < 2) return notFound()
    const path = parts.slice(1).join('/')
    // Only a path the listing holds is joined: `..`, absolute paths and odd encodings match nothing.
    if (!listShots(rawDir, target, false).some((shot) => shot.path === path)) return notFound()
    return await file(join(rawDir, target, ...path.split('/')), 'image/png')
  }

  const postShot = async (route: string, req: Request): Promise<Response> => {
    const parts = segments(route)
    const target = parts?.[0]
    if (!parts || target === undefined || !isTarget(target)) return notFound()
    const rest = parts.slice(1)
    // `<name>.png`, or `<locale>/<name>.png` for a locale dir.
    const locale = rest.length === 2 ? rest[0] : undefined
    const name = rest[rest.length - 1] ?? ''
    if (rest.length < 1 || rest.length > 2 || (locale !== undefined && !isLocale(locale))) {
      return fail(422, 'The name is <file>.png, or <locale>/<file>.png')
    }
    if (!plainName(name) || !SHOT_NAME.test(name)) {
      return fail(422, `"${name}" is not a PNG file name (no slashes, no leading dot, ends in .png)`)
    }
    const bytes = new Uint8Array(await req.arrayBuffer())
    let info
    try {
      info = imageInfo(bytes)
    } catch (e) {
      return fail(422, e instanceof KitError ? e.message : 'The body is not a PNG')
    }
    if (info.format !== 'png') return fail(422, 'The body is a JPEG; only PNG shots are taken')
    const dir = locale === undefined ? join(rawDir, target) : join(rawDir, target, locale)
    const path = join(dir, name)
    const replace = new URL(req.url).searchParams.get('replace') === '1'
    if (existsSync(path) && !replace) {
      return fail(409, `${target}/${rest.join('/')} exists already; add ?replace=1 to overwrite it`)
    }
    writeAtomic(path, bytes)
    const shot: StudioShot = {
      file: name,
      path: rest.join('/'),
      ...(locale === undefined ? {} : { locale }),
      width: info.width,
      height: info.height,
    }
    return json(shot)
  }

  const postExport = async (req: Request): Promise<Response> => {
    let input: unknown
    try {
      input = await req.json()
    } catch {
      return fail(422, 'The body is not JSON')
    }
    const { stores, locales } = (input ?? {}) as Partial<StudioExportRequest>
    const okStores =
      Array.isArray(stores) &&
      stores.length > 0 &&
      stores.every((s) => (STORES as readonly unknown[]).includes(s))
    if (!okStores) return fail(422, 'stores is a non-empty list of apple and google')
    if (locales !== undefined && !(Array.isArray(locales) && locales.every((l) => typeof l === 'string'))) {
      return fail(422, 'locales is a list of locale codes')
    }
    if (exporting) return fail(409, 'An export is already running')
    exporting = true
    try {
      const result = await opts.runExport({ stores, ...(locales === undefined ? {} : { locales }) })
      return json(result)
    } catch (e) {
      if (e instanceof KitError) {
        return fail(422, e.message)
      }
      throw e
    } finally {
      exporting = false
    }
  }

  const get = async (route: string): Promise<Response> => {
    if (route === 'api/session') return json(session)
    if (route === 'api/project') return getProject()
    if (route === 'api/shots') {
      const shots = Object.fromEntries(
        TARGETS.map((target) => [target, listShots(rawDir, target, true)]),
      ) as StudioShots
      return json(shots)
    }
    if (route.startsWith('api/shot/')) return await getShot(route.slice('api/shot/'.length))
    if (route.startsWith('api/asset/')) {
      const n = route.slice('api/asset/'.length)
      const asset = /^\d+$/.test(n) ? opts.assets[Number(n)] : undefined
      if (asset === undefined) return notFound()
      return await file(asset, CONTENT_TYPES[extname(asset).toLowerCase()] ?? 'application/octet-stream')
    }
    if (route.startsWith('api/')) return notFound()
    if (!hasEditor) return route === '' ? body(PLACEHOLDER, 'text/html; charset=utf-8') : notFound()
    return await editorFile(opts.editorDir!, route === '' ? 'index.html' : route)
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    maxRequestBodySize: MAX_BODY,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (!pathname.startsWith(prefix)) return notFound()
      const route = pathname.slice(prefix.length)
      if (req.method === 'GET') return await get(route)
      if (req.method === 'PUT' && route === 'api/project') {
        // One save at a time: the hash check and the rename are not atomic together.
        const run = saving.then(async () => {
          let value: unknown
          try {
            value = await req.json()
          } catch {
            return fail(422, 'The body is not JSON')
          }
          return putProject(value)
        })
        saving = run.catch(() => undefined)
        return await run
      }
      if (req.method === 'POST') {
        if (route === 'api/export') return await postExport(req)
        if (route.startsWith('api/shot/')) return await postShot(route.slice('api/shot/'.length), req)
      }
      return notFound()
    },
    error() {
      return fail(500, 'Internal error')
    },
  })

  let stopped: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${server.port}${prefix}`,
    stop() {
      stopped ??= server.stop(true)
      return stopped
    },
  }
}
