/** Shared pieces of the store fakes. */

export interface Req {
  /** Set on the shared log: which fake answered. */
  store?: 'asc' | 'play' | 'rc' | 'token' | 'upload'
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  auth: string
}

export type Json = Record<string, unknown>

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
