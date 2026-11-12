import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'
import { type ExportPlan, type PageDone, pagePlan } from './types'

/**
 * The render host's HTTP side: serves one `ExportPlan` to headless Chrome and collects what the
 * page posts back. The protocol is documented at `PagePlan` in `types.ts`.
 *
 * It listens on `127.0.0.1` at a port the OS picks, and every route sits under a random path
 * token: a local process that finds the port still cannot read the raw shots or post a result
 * without the URL. `renderJobs` keeps the URL off Chrome's command line (which `ps` shows every
 * local user) by handing Chrome a file in its 0700 work dir. The token does not protect against
 * a process running as the same user, which can read that file and Chrome's profile.
 */

export interface ShotsServerOptions {
  /** The page JS (`pageBundle()`), served as `page.js`. */
  page: string
  /** Called with the job id each time the page posts a PNG to `out/<jobId>`. */
  onImage?: (jobId: string) => void
}

export interface ShotsServer {
  /** `http://127.0.0.1:<port>/<token>/`: the URL Chrome opens. */
  url: string
  /** Settles with the first `POST done`. Never rejects; pending until the page posts. */
  done: Promise<PageDone>
  /** The PNG bodies posted to `out/<jobId>`, by job id. A second post for a job replaces the first. */
  images: Map<string, Uint8Array>
  /** Close the listener and drop open connections. Safe to call twice. */
  stop(): Promise<void>
}

const CONTENT_TYPES: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/**
 * The document Chrome opens. The inline script reports what the page bundle cannot report itself:
 * a bundle that fails to load or to evaluate would otherwise leave kit waiting for the timeout.
 */
const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>kit shots export</title>
<style>html, body { margin: 0; background: #fff; }</style>
<script>
addEventListener('error', (e) => {
  const script = e.target instanceof HTMLScriptElement
  if (e.target !== window && !script) return
  const error = script ? 'page.js failed to load' : e.message || 'The page threw an error'
  fetch('done', { method: 'POST', body: JSON.stringify({ ok: false, error }) })
}, true)
</script>
</head>
<body>
<script type="module" src="page.js"></script>
</body>
</html>
`

const NO_STORE = { 'cache-control': 'no-store' }

const notFound = (): Response => new Response('Not found', { status: 404 })

function body(data: string | Blob, type: string): Response {
  return new Response(data, { headers: { 'content-type': type, ...NO_STORE } })
}

async function file(path: string, type: string): Promise<Response> {
  const data = Bun.file(path)
  return (await data.exists()) ? body(data, type) : notFound()
}

function parseDone(text: string): PageDone {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean') {
      const error = 'error' in value && typeof value.error === 'string' ? value.error : undefined
      const job = 'job' in value && typeof value.job === 'string' ? { job: value.job } : {}
      return error === undefined ? { ok: value.ok, ...job } : { ok: value.ok, error, ...job }
    }
  } catch {
    // reported below
  }
  return { ok: false, error: 'The page posted a done message kit could not read' }
}

/** Start serving `plan`. The caller stops the server (`renderJobs` registers it with `lib/cleanup`). */
export function serveShots(plan: ExportPlan, opts: ShotsServerOptions): ShotsServer {
  const token = randomBytes(16).toString('hex')
  const prefix = `/${token}/`
  const jobs = new Map(plan.jobs.map((job) => [job.id, job]))
  const images = new Map<string, Uint8Array>()
  const planJson = JSON.stringify(pagePlan(plan))
  const { promise: done, resolve: finish } = Promise.withResolvers<PageDone>()

  const get = async (route: string): Promise<Response> => {
    if (route === '') return body(HTML, 'text/html; charset=utf-8')
    if (route === 'page.js') return body(opts.page, 'text/javascript; charset=utf-8')
    if (route === 'plan.json') return body(planJson, 'application/json; charset=utf-8')
    if (route.startsWith('shot/')) {
      const job = jobs.get(route.slice('shot/'.length))
      return job ? await file(job.shot, 'image/png') : notFound()
    }
    if (route.startsWith('asset/')) {
      const n = route.slice('asset/'.length)
      const asset = /^\d+$/.test(n) ? plan.assets[Number(n)] : undefined
      if (asset === undefined) return notFound()
      return await file(asset, CONTENT_TYPES[extname(asset).toLowerCase()] ?? 'application/octet-stream')
    }
    return notFound()
  }

  const post = async (route: string, req: Request): Promise<Response> => {
    if (route === 'done') {
      finish(parseDone(await req.text()))
      return new Response(null, { status: 204 })
    }
    if (route.startsWith('out/')) {
      const id = route.slice('out/'.length)
      if (!jobs.has(id)) return notFound()
      images.set(id, new Uint8Array(await req.arrayBuffer()))
      opts.onImage?.(id)
      return new Response(null, { status: 204 })
    }
    return notFound()
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (!pathname.startsWith(prefix)) return notFound()
      const route = pathname.slice(prefix.length)
      if (req.method === 'GET') return await get(route)
      if (req.method === 'POST') return await post(route, req)
      return notFound()
    },
    error() {
      return new Response('Internal error', { status: 500 })
    },
  })

  let stopped: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${server.port}${prefix}`,
    done,
    images,
    stop() {
      stopped ??= server.stop(true)
      return stopped
    },
  }
}
