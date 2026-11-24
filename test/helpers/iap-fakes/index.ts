/**
 * Stateful stand-ins for App Store Connect, Google Play and RevenueCat: in-memory catalogs that
 * writes change and reads report, in each store's own JSON shapes (plan-4 research notes). One
 * Bun server serves all three under prefixes: `/asc`, `/play` (+ `/token`) and `/rc/v2`.
 */

import { FakeAsc } from './asc'
import { json, type Req } from './common'
import { FakePlay } from './play'
import { FakeRc } from './rc'

export type { Req } from './common'
export { FakeAsc } from './asc'
export { FakePlay, money } from './play'
export { FakeRc } from './rc'

export interface Fakes {
  asc: FakeAsc
  play: FakePlay
  rc: FakeRc
  /** Every request, in order. */
  log: Req[]
  writes(store?: 'asc' | 'play' | 'rc'): Req[]
  env(): Record<string, string>
  stop(): void
}

export function startFakes(): Fakes {
  const log: Req[] = []
  let origin = ''
  const asc = new FakeAsc(() => origin)
  const play = new FakePlay()
  const rc = new FakeRc()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === 'PUT' ? '' : await request.text()
      let body: unknown
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = text
      }
      const auth = request.headers.get('authorization') ?? ''
      const at = (prefix: string) => url.pathname.slice(prefix.length).replace(/^\/+/, '')
      if (url.pathname === '/token') {
        log.push({
          store: 'token',
          method: request.method,
          path: 'token',
          query: url.searchParams,
          body: text,
          auth,
        })
        return json({ access_token: 'ya29.fake-token', expires_in: 3600, token_type: 'Bearer' })
      }
      if (url.pathname.startsWith('/upload/')) {
        const bytes = (await request.arrayBuffer()).byteLength
        log.push({
          store: 'upload',
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          body: bytes,
          auth,
        })
        return asc.upload(url.pathname.slice('/upload/'.length), bytes, auth)
      }
      for (const [prefix, store, fake] of [
        ['/asc', 'asc', asc],
        ['/play', 'play', play],
        ['/rc/v2', 'rc', rc],
      ] as const) {
        if (url.pathname.startsWith(`${prefix}/`)) {
          const req = { method: request.method, path: at(prefix), query: url.searchParams, body, auth }
          log.push({ store, ...req })
          return fake.handle(req)
        }
      }
      return new Response('no such fake', { status: 404 })
    },
  })
  origin = `http://localhost:${server.port}`
  return {
    asc,
    play,
    rc,
    log,
    writes: (store) =>
      log.filter((r) => r.method !== 'GET' && (!store || r.store === store) && r.store !== 'token'),
    env: () => ({
      KIT_ASC_API_URL: `${origin}/asc`,
      KIT_PLAY_API_URL: `${origin}/play`,
      KIT_GOOGLE_TOKEN_URL: `${origin}/token`,
      KIT_RC_API_URL: `${origin}/rc/v2`,
    }),
    stop: () => server.stop(true),
  }
}
