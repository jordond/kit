import { createPrivateKey, sign } from 'node:crypto'
import { registerSecret } from '../secrets'

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url')

/**
 * An App Store Connect API token (ES256). Apple caps a token's life at 20 minutes; the default
 * 5 suits a single check (`release setup ios`).
 */
export function ascToken(
  keyId: string,
  issuerId: string,
  p8: string,
  now = Date.now(),
  ttlSeconds = 300,
): string {
  const iat = Math.floor(now / 1000)
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const body = b64url(
    JSON.stringify({ iss: issuerId, iat, exp: iat + ttlSeconds, aud: 'appstoreconnect-v1' }),
  )
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(p8),
    dsaEncoding: 'ieee-p1363',
  })
  return `${head}.${body}.${b64url(signature)}`
}

/** A bearer token for each request; minted for 19 minutes and re-minted when under 2 are left. */
export type TokenSource = () => Promise<string>

export function ascTokenSource(
  creds: { keyId: string; issuerId: string; p8: string },
  clock: () => number = Date.now,
): TokenSource {
  let token = ''
  let expires = 0
  return async () => {
    const now = clock()
    if (!token || expires - now < 120_000) {
      token = ascToken(creds.keyId, creds.issuerId, creds.p8, now, 19 * 60)
      expires = now + 19 * 60_000
      registerSecret(token)
    }
    return token
  }
}
