import { createPrivateKey, sign } from 'node:crypto'
import { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import { redact, registerSecret } from '../secrets'
import type { TokenSource } from './asc-token'

/**
 * Google service-account OAuth: an RS256 JWT assertion exchanged at the account's `token_uri` for
 * a bearer token (https://developers.google.com/identity/protocols/oauth2/service-account#httprest).
 * `KIT_GOOGLE_TOKEN_URL` replaces the token endpoint (tests).
 */

export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher'

const serviceAccount = z.object({
  type: z.literal('service_account'),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().default('https://oauth2.googleapis.com/token'),
})
export type ServiceAccount = z.output<typeof serviceAccount>

/** Decode `PLAY_SERVICE_ACCOUNT_BASE64`; the private key is registered for redaction. */
export function parseServiceAccount(base64: string): ServiceAccount {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(base64.replace(/\s+/g, ''), 'base64').toString('utf8'))
  } catch {
    json = undefined
  }
  const parsed = serviceAccount.safeParse(json)
  if (!parsed.success) {
    throw new KitError(
      'PLAY_SERVICE_ACCOUNT_BASE64 does not decode to a Google service-account JSON',
      undefined,
      ExitCode.config,
    )
  }
  registerSecret(parsed.data.private_key)
  return parsed.data
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url')

/** The signed assertion for `scope`, valid one hour. */
export function googleAssertion(sa: ServiceAccount, scope: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(
    JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri, iat, exp: iat + 3600 }),
  )
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), createPrivateKey(sa.private_key))
  return `${head}.${body}.${b64url(signature)}`
}

const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().optional() })

/** Bearer tokens for `scope`, fetched once and again when under 2 minutes are left. */
export function googleTokenSource(
  sa: ServiceAccount,
  scope = ANDROID_PUBLISHER_SCOPE,
  clock: () => number = Date.now,
): TokenSource {
  let token = ''
  let expires = 0
  return async () => {
    const now = clock()
    if (token && expires - now > 120_000) return token
    const url = process.env.KIT_GOOGLE_TOKEN_URL || sa.token_uri
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: googleAssertion(sa, scope, now),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new KitError(
        `Google refused the service account (HTTP ${res.status}): ${redact(text.slice(0, 300))}`,
        'Check PLAY_SERVICE_ACCOUNT_BASE64; new keys can take a while to start working',
        ExitCode.config,
      )
    }
    const parsed = tokenResponse.safeParse(JSON.parse(text))
    if (!parsed.success)
      throw new KitError('Google token response had no access_token', undefined, ExitCode.config)
    token = parsed.data.access_token
    expires = now + (parsed.data.expires_in ?? 3600) * 1000
    registerSecret(token)
    return token
  }
}
