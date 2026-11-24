import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import { redact } from '../secrets'
import type { TokenSource } from '../stores/asc-token'
import { STORE_NAME, type Store } from './types'

/**
 * The one HTTP path of `kit iap` (plan-4 §4 http.ts): JSON in and out, every response zod-parsed,
 * one retry on 429 / 5xx / 423, store error bodies turned into `StoreError`, optional pacing
 * (RevenueCat) and recording (`KIT_IAP_RECORD=<dir>`).
 */

export const BASE_URLS: Record<Store, { env: string; url: string }> = {
  apple: { env: 'KIT_ASC_API_URL', url: 'https://api.appstoreconnect.apple.com' },
  play: { env: 'KIT_PLAY_API_URL', url: 'https://androidpublisher.googleapis.com/androidpublisher/v3' },
  revenuecat: { env: 'KIT_RC_API_URL', url: 'https://api.revenuecat.com/v2' },
}

export const baseUrl = (store: Store): string =>
  (process.env[BASE_URLS[store].env] || BASE_URLS[store].url).replace(/\/+$/, '')

/** What a 401/403 needs, per store. */
const AUTH_HINT: Record<Store, string> = {
  apple: 'The App Store Connect API key needs the App Manager role (or Admin)',
  play: 'The service account needs Play Console access to the app with permission to manage store presence (products)',
  revenuecat:
    'The RevenueCat v2 secret key needs project_configuration:apps:read, project_configuration:products:read_write and project_configuration:entitlements:read_write',
}

export class StoreError extends Error {
  constructor(
    readonly store: Store,
    readonly status: number,
    readonly code: string | undefined,
    readonly detail: string,
    readonly pointer?: string,
    readonly hint?: string,
    /** `PATCH /v1/…`: kept out of `detail` so callers can match the store's own words. */
    readonly request?: string,
  ) {
    super(
      redact(
        `${STORE_NAME[store]}: HTTP ${status}${code ? ` ${code}` : ''}: ${request ? `${request}: ` : ''}${detail}${pointer ? ` (${pointer})` : ''}${hint ? `. ${hint}` : ''}`,
      ),
    )
    this.name = 'StoreError'
  }
}

/** Code, detail and pointer from a store's error body; falls back to the raw text. */
export function parseError(
  store: Store,
  body: unknown,
  text: string,
): { code?: string; detail: string; pointer?: string; backoffMs?: number } {
  const b = (body ?? {}) as Record<string, unknown>
  if (store === 'apple' && Array.isArray(b.errors) && b.errors.length) {
    const e = b.errors[0] as {
      code?: string
      title?: string
      detail?: string
      source?: { pointer?: string; parameter?: string }
    }
    return {
      code: e.code,
      detail: e.detail ?? e.title ?? text,
      pointer: e.source?.pointer ?? e.source?.parameter,
    }
  }
  if (store === 'play' && b.error && typeof b.error === 'object') {
    const e = b.error as { status?: string; message?: string }
    return { code: e.status, detail: e.message ?? text }
  }
  if (store === 'revenuecat' && typeof b.message === 'string') {
    return {
      code: typeof b.type === 'string' ? b.type : undefined,
      detail: b.message,
      pointer: typeof b.param === 'string' ? b.param : undefined,
      backoffMs: typeof b.backoff_ms === 'number' ? b.backoff_ms : undefined,
    }
  }
  return { detail: text.trim().slice(0, 500) || '(empty body)' }
}

/** Serialises calls at most one per `intervalMs` (RevenueCat: 60 project-config calls a minute). */
export interface Pacer {
  wait(): Promise<void>
}

export function createPacer(
  intervalMs: number,
  clock: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Pacer {
  let next = 0
  let chain = Promise.resolve()
  return {
    wait() {
      const turn = chain.then(async () => {
        const now = clock()
        if (next > now) await sleep(next - now)
        next = Math.max(now, next) + intervalMs
      })
      chain = turn
      return turn
    },
  }
}

export interface RequestOptions<T> {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  schema: z.ZodType<T>
}

export interface Client {
  store: Store
  base: string
  /** `path` is relative to the base URL, or an absolute URL on the base's origin (paging links). */
  request<T>(method: string, path: string, opts: RequestOptions<T>): Promise<T>
}

export interface ClientOptions {
  store: Store
  token: TokenSource
  base?: string
  pace?: Pacer
  sleep?: (ms: number) => Promise<void>
  /** Default 2000: the wait when a retryable response names none. */
  retryMs?: number
  /** Told about each request as it goes out, and about a retry's wait: progress lines. */
  onProgress?: (line: string) => void
}

let recorded = 0

/**
 * Apple's screenshot reservations carry pre-signed upload URLs and headers: capabilities valid for
 * days, not registered secrets. Recordings keep their shape, never their values.
 */
function maskUploads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskUploads)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'uploadOperations' && Array.isArray(v)) {
      out[k] = v.map((op: Record<string, unknown>) => ({
        ...op,
        url: '<masked>',
        requestHeaders: Array.isArray(op.requestHeaders)
          ? op.requestHeaders.map((h: Record<string, unknown>) => ({ ...h, value: '<masked>' }))
          : op.requestHeaders,
      }))
    } else out[k] = maskUploads(v)
  }
  return out
}

function record(
  store: Store,
  method: string,
  url: string,
  body: unknown,
  status: number,
  response: string,
): void {
  const dir = process.env.KIT_IAP_RECORD
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const path = new URL(url).pathname.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const name = `${String(++recorded).padStart(4, '0')}-${store}-${method}-${path}`.slice(0, 120)
  let parsed: unknown = response
  try {
    parsed = JSON.parse(response)
  } catch {
    // Not JSON: kept as text.
  }
  const doc = { request: { method, url, body }, response: { status, body: maskUploads(parsed) } }
  writeFileSync(join(dir, `${name}.json`), `${redact(JSON.stringify(doc, null, 2))}\n`)
}

/** The longest a store may ask kit to wait before the one retry; a longer ask fails the request. */
export const MAX_RETRY_WAIT_MS = 60_000

function retryWait(res: Response, backoffMs: number | undefined, fallback: number): number {
  const after = res.headers.get('retry-after')
  if (after !== null && /^\d+(\.\d+)?$/.test(after.trim())) return Number(after) * 1000
  return backoffMs ?? fallback
}

export function createClient(opts: ClientOptions): Client {
  const base = (opts.base ?? baseUrl(opts.store)).replace(/\/+$/, '')
  const origin = new URL(base).origin
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms))
  const resolve = (path: string, query: RequestOptions<unknown>['query']): string => {
    let url: URL
    if (/^https?:\/\//.test(path)) {
      url = new URL(path)
      // The bearer token goes to the store only, never to a host a response named.
      if (url.origin !== origin)
        throw new Error(`${STORE_NAME[opts.store]}: refusing to follow ${url.origin}`)
    } else url = new URL(`${base}/${path.replace(/^\/+/, '')}`)
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) url.searchParams.append(k, String(v))
    return url.toString()
  }

  return {
    store: opts.store,
    base,
    async request<T>(method: string, path: string, r: RequestOptions<T>): Promise<T> {
      const url = resolve(path, r.query)
      const label = `${method} ${new URL(url).pathname}`
      for (let attempt = 1; ; attempt++) {
        await opts.pace?.wait()
        opts.onProgress?.(label)
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${await opts.token()}`,
            Accept: 'application/json',
            ...(r.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
          signal: AbortSignal.timeout(60_000),
        })
        const text = await res.text()
        record(opts.store, method, url, r.body, res.status, text)
        let json: unknown = null
        if (text.trim()) {
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
        }
        if (!res.ok) {
          const err = parseError(opts.store, json, text)
          const retryable = res.status === 429 || res.status === 423 || res.status >= 500
          if (retryable && attempt === 1) {
            const wait = retryWait(res, err.backoffMs, opts.retryMs ?? 2000)
            // An hourly quota can ask for a long wait: fail with it rather than hang the run.
            if (wait <= MAX_RETRY_WAIT_MS) {
              opts.onProgress?.(`${label}: HTTP ${res.status}, retrying in ${Math.ceil(wait / 1000)} s`)
              await sleep(wait)
              continue
            }
            throw new StoreError(
              opts.store,
              res.status,
              err.code,
              `${err.detail}; the store asks to wait ${Math.ceil(wait / 1000)} s, run again later`,
              err.pointer,
              undefined,
              label,
            )
          }
          const hint = res.status === 401 || res.status === 403 ? AUTH_HINT[opts.store] : undefined
          throw new StoreError(opts.store, res.status, err.code, err.detail, err.pointer, hint, label)
        }
        if (json === undefined) {
          throw new StoreError(opts.store, res.status, undefined, `${label}: response is not JSON`)
        }
        const parsed = r.schema.safeParse(json)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]!
          throw new StoreError(
            opts.store,
            res.status,
            'UNEXPECTED_RESPONSE',
            `${label}: ${issue.path.join('.') || '(root)'}: ${issue.message}`,
          )
        }
        return parsed.data
      }
    },
  }
}
