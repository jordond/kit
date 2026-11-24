import { registerSecret } from '../secrets'
import { ascTokenSource, type TokenSource } from '../stores/asc-token'
import { googleTokenSource, parseServiceAccount } from '../stores/google-token'
import type { StoreTargets } from './model'
import type { Store } from './types'

/**
 * Credentials per store under the release secret names (`src/lib/release/creds.ts`), plus the
 * RevenueCat key (`iap.revenuecat.apiKeyEnv`). Never throws: a store without credentials is
 * skipped with the reason while the others run.
 */

export type IapCreds = { ok: true; token: TokenSource } | { ok: false; reason: string }

export const APPLE_IAP_SECRETS = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_BASE64']
export const PLAY_IAP_SECRETS = ['PLAY_SERVICE_ACCOUNT_BASE64']

/** The env vars each configured store reads. */
export function iapSecretNames(targets: StoreTargets): Partial<Record<Store, string[]>> {
  return {
    ...(targets.apple ? { apple: APPLE_IAP_SECRETS } : {}),
    ...(targets.play ? { play: PLAY_IAP_SECRETS } : {}),
    ...(targets.revenuecat ? { revenuecat: [targets.revenuecat.apiKeyEnv] } : {}),
  }
}

export function iapCreds(
  store: Store,
  targets: StoreTargets,
  env: Record<string, string | undefined> = process.env,
): IapCreds {
  const names = iapSecretNames(targets)[store] ?? []
  const missing = names.filter((n) => !env[n]?.trim())
  if (missing.length) return { ok: false, reason: `missing ${missing.join(', ')}` }
  const v = (n: string) => env[n]!.trim()
  for (const n of names) registerSecret(v(n))
  if (store === 'apple') {
    const p8 = Buffer.from(v('ASC_KEY_P8_BASE64').replace(/\s+/g, ''), 'base64').toString('utf8')
    if (!p8.includes('-----BEGIN PRIVATE KEY-----')) {
      return { ok: false, reason: 'ASC_KEY_P8_BASE64 does not decode to a .p8 private key' }
    }
    registerSecret(p8)
    return { ok: true, token: ascTokenSource({ keyId: v('ASC_KEY_ID'), issuerId: v('ASC_ISSUER_ID'), p8 }) }
  }
  if (store === 'play') {
    try {
      return { ok: true, token: googleTokenSource(parseServiceAccount(v('PLAY_SERVICE_ACCOUNT_BASE64'))) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }
  const key = v(names[0]!)
  if (!key.startsWith('sk_')) {
    return { ok: false, reason: `${names[0]} is not a RevenueCat secret key (sk_…); use a v2 secret key` }
  }
  return { ok: true, token: async () => key }
}
