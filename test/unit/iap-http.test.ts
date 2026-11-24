import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { checkIapCredentials } from '../../src/lib/doctor/checks'
import { iapCreds, iapSecretNames } from '../../src/lib/iap/creds'
import { createClient, createPacer, StoreError } from '../../src/lib/iap/http'
import { registerSecret, resetSecrets } from '../../src/lib/secrets'
import { ascTokenSource } from '../../src/lib/stores/asc-token'
import { googleTokenSource, parseServiceAccount } from '../../src/lib/stores/google-token'

type Handler = (req: Request) => Response | Promise<Response>
let handler: Handler = () => new Response('{}')
const seen: { method: string; path: string; auth: string; body: string }[] = []
let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        auth: req.headers.get('authorization') ?? '',
        body: await req.clone().text(),
      })
      return handler(req)
    },
  })
})
afterAll(() => server.stop(true))
afterEach(() => {
  seen.length = 0
  resetSecrets()
  delete process.env.KIT_IAP_RECORD
})

const base = () => `http://localhost:${server.port}/v2`
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function client(store: 'apple' | 'play' | 'revenuecat' = 'revenuecat') {
  const waits: number[] = []
  const c = createClient({
    store,
    base: base(),
    token: async () => 'sk_test_token',
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  return { c, waits }
}

const ok = z.object({ ok: z.boolean() })

describe('http client', () => {
  test('sends JSON with the bearer token and parses the response', async () => {
    handler = () => json({ ok: true, extra: 1 })
    const { c } = client()
    expect(
      await c.request('POST', 'projects/p/products', { body: { a: 1 }, schema: ok, query: { limit: 100 } }),
    ).toEqual({ ok: true })
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/v2/projects/p/products?limit=100',
      auth: 'Bearer sk_test_token',
      body: '{"a":1}',
    })
  })

  test('retries a 5xx once, waiting Retry-After seconds', async () => {
    let n = 0
    handler = () => (++n === 1 ? json({}, 500, { 'retry-after': '3' }) : json({ ok: true }))
    const { c, waits } = client('play')
    expect(await c.request('GET', 'x', { schema: ok })).toEqual({ ok: true })
    expect(waits).toEqual([3000])
    expect(seen).toHaveLength(2)
  })

  test('429 waits RevenueCat backoff_ms; a second failure throws', async () => {
    handler = () => json({ type: 'rate_limit_error', message: 'slow down', backoff_ms: 1500 }, 429)
    const { c, waits } = client()
    const err = (await c.request('GET', 'x', { schema: ok }).catch((e: unknown) => e)) as StoreError
    expect(err).toBeInstanceOf(StoreError)
    expect(err.status).toBe(429)
    expect(err.code).toBe('rate_limit_error')
    expect(waits).toEqual([1500])
    expect(seen).toHaveLength(2)
  })

  test('423 (RevenueCat lock) is retried once with the 2 s default', async () => {
    let n = 0
    handler = () =>
      ++n === 1 ? json({ type: 'resource_locked_error', message: 'locked' }, 423) : json({ ok: true })
    const { c, waits } = client()
    await c.request('POST', 'x', { body: {}, schema: ok })
    expect(waits).toEqual([2000])
  })

  test('4xx is not retried; Apple errors carry code and pointer', async () => {
    handler = () =>
      json(
        {
          errors: [
            {
              status: '409',
              code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE',
              title: 'dup',
              detail: 'This product ID has already been used',
              source: { pointer: '/data/attributes/productId' },
            },
          ],
        },
        409,
      )
    const { c, waits } = client('apple')
    const err = (await c
      .request('POST', 'v2/inAppPurchases', { body: {}, schema: ok })
      .catch((e: unknown) => e)) as StoreError
    expect(waits).toEqual([])
    expect(err.message).toBe(
      'App Store Connect: HTTP 409 ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE: POST /v2/v2/inAppPurchases: This product ID has already been used (/data/attributes/productId)',
    )
  })

  test('Play error body', async () => {
    handler = () =>
      json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad regions version' } }, 400)
    const { c } = client('play')
    const err = (await c.request('GET', 'x', { schema: ok }).catch((e: unknown) => e)) as StoreError
    expect(err.code).toBe('INVALID_ARGUMENT')
    expect(err.message).toContain('bad regions version')
  })

  test('401/403 name what the credentials need', async () => {
    handler = () => json({ type: 'authorization_error', message: 'forbidden' }, 403)
    const { c } = client()
    const err = (await c.request('GET', 'x', { schema: ok }).catch((e: unknown) => e)) as StoreError
    expect(err.message).toContain('project_configuration:apps:read')
    expect(err.message).toContain('project_configuration:products:read_write')
    expect(err.message).toContain('project_configuration:entitlements:read_write')
  })

  test('a response missing a required key fails with the path', async () => {
    handler = () => json({ nope: true })
    const { c } = client()
    const err = (await c.request('GET', 'x', { schema: ok }).catch((e: unknown) => e)) as StoreError
    expect(err.code).toBe('UNEXPECTED_RESPONSE')
    expect(err.message).toContain('ok:')
  })

  test('error text is redacted', async () => {
    registerSecret('sk_secret_value_123')
    handler = () => json({ type: 'parameter_error', message: 'bad key sk_secret_value_123' }, 400)
    const { c } = client()
    const err = (await c.request('GET', 'x', { schema: ok }).catch((e: unknown) => e)) as StoreError
    expect(err.message).toContain('bad key ***')
  })

  test('follows absolute links only on the store origin', async () => {
    handler = () => json({ ok: true })
    const { c } = client('apple')
    await c.request('GET', `http://localhost:${server.port}/v1/next?cursor=a`, { schema: ok })
    expect(seen[0]!.path).toBe('/v1/next?cursor=a')
    await expect(c.request('GET', 'https://example.com/v1/x', { schema: ok })).rejects.toThrow(
      'refusing to follow',
    )
  })

  test('KIT_IAP_RECORD writes redacted request/response pairs, no auth header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-iap-rec-'))
    process.env.KIT_IAP_RECORD = dir
    registerSecret('private-thing')
    handler = () => json({ ok: true, echo: 'private-thing' })
    const { c } = client()
    await c.request('POST', 'projects/p/products', { body: { name: 'private-thing' }, schema: ok })
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-revenuecat-POST-v2-projects-p-products\.json$/)
    const text = readFileSync(join(dir, files[0]!), 'utf8')
    expect(text).not.toContain('private-thing')
    expect(text).not.toContain('sk_test_token')
    expect(JSON.parse(text).response.status).toBe(200)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('pacer', () => {
  test('spaces calls by the interval on an injected clock', async () => {
    let now = 1_000
    const slept: number[] = []
    const pacer = createPacer(
      1000,
      () => now,
      async (ms) => {
        slept.push(ms)
        now += ms
      },
    )
    await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()])
    expect(slept).toEqual([1000, 1000])
    now += 5000
    await pacer.wait()
    expect(slept).toEqual([1000, 1000])
  })
})

describe('tokens', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

  test('ASC tokens live 19 minutes and are re-minted with under 2 left', async () => {
    let now = 1_700_000_000_000
    const source = ascTokenSource({ keyId: 'KEY', issuerId: 'ISS', p8 }, () => now)
    const first = await source()
    const claims = JSON.parse(Buffer.from(first.split('.')[1]!, 'base64url').toString())
    expect(claims.exp - claims.iat).toBe(19 * 60)
    now += 16 * 60_000
    expect(await source()).toBe(first)
    now += 2 * 60_000
    expect(await source()).not.toBe(first)
  })

  test('Google: RS256 assertion exchanged at the token endpoint, cached', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const sa = {
      type: 'service_account',
      client_email: 'kit@project.iam.gserviceaccount.com',
      private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      token_uri: 'https://oauth2.googleapis.com/token',
    }
    const parsed = parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString('base64'))
    process.env.KIT_GOOGLE_TOKEN_URL = `http://localhost:${server.port}/token`
    handler = () => json({ access_token: 'ya29.token', expires_in: 3600 })
    try {
      const source = googleTokenSource(parsed)
      expect(await source()).toBe('ya29.token')
      expect(await source()).toBe('ya29.token')
      expect(seen).toHaveLength(1)
      const form = new URLSearchParams(seen[0]!.body)
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
      const [head, body, sig] = form.get('assertion')!.split('.') as [string, string, string]
      expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
      expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toMatchObject({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/androidpublisher',
        aud: sa.token_uri,
      })
      expect(
        verify('sha256', Buffer.from(`${head}.${body}`), rsa.publicKey, Buffer.from(sig, 'base64url')),
      ).toBe(true)
    } finally {
      delete process.env.KIT_GOOGLE_TOKEN_URL
    }
  })

  test('a service account that is not one is a config error', () => {
    expect(() => parseServiceAccount(Buffer.from('{"type":"user"}').toString('base64'))).toThrow(
      'service-account',
    )
  })
})

describe('credentials', () => {
  const targets = {
    apple: { bundleId: 'a.b', familySharing: false },
    play: { packageName: 'a.b' },
    revenuecat: { projectId: 'p', apiKeyEnv: 'RC_KEY' },
  }

  test('names per configured store', () => {
    expect(iapSecretNames(targets)).toEqual({
      apple: ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_BASE64'],
      play: ['PLAY_SERVICE_ACCOUNT_BASE64'],
      revenuecat: ['RC_KEY'],
    })
    expect(iapSecretNames({ play: targets.play })).toEqual({ play: ['PLAY_SERVICE_ACCOUNT_BASE64'] })
  })

  test('missing or wrong values are reasons, not throws', () => {
    expect(iapCreds('apple', targets, {})).toEqual({
      ok: false,
      reason: 'missing ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64',
    })
    expect(iapCreds('revenuecat', targets, { RC_KEY: 'pk_public' })).toMatchObject({ ok: false })
    expect(iapCreds('play', targets, { PLAY_SERVICE_ACCOUNT_BASE64: 'bm90IGpzb24=' })).toMatchObject({
      ok: false,
    })
    expect(
      iapCreds('apple', targets, { ASC_KEY_ID: 'K', ASC_ISSUER_ID: 'I', ASC_KEY_P8_BASE64: 'bm9wZQ==' }),
    ).toMatchObject({ ok: false })
  })

  test('a RevenueCat secret key is its own token', async () => {
    const c = iapCreds('revenuecat', targets, { RC_KEY: 'sk_abc123' })
    expect(c.ok).toBe(true)
    if (c.ok) expect(await c.token()).toBe('sk_abc123')
  })

  test('doctor: iap-credentials', () => {
    expect(checkIapCredentials(undefined, {}).status).toBe('skip')
    expect(checkIapCredentials(iapSecretNames(targets), {})).toMatchObject({
      status: 'warn',
      detail:
        'apple: missing ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64; play: missing PLAY_SERVICE_ACCOUNT_BASE64; revenuecat: missing RC_KEY',
    })
    expect(checkIapCredentials({ revenuecat: ['RC_KEY'] }, { RC_KEY: 'sk_x' })).toMatchObject({
      status: 'ok',
      detail: 'revenuecat',
    })
  })
})
