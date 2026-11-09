import { readFileSync } from 'node:fs'
import { ExitCode, KitError } from '../errors'
import { decodeSecretFile, registerSecret } from '../secrets'

/**
 * Store and signing credentials under their canonical names (PLAN §9.5). Values come from the
 * environment (the root .env, or CI secrets); files are decoded into the run's 0600 temp dir and
 * passed to lanes as paths. Every value is registered for redaction.
 */

/** Old name → canonical, for a hint when only the old one is set. */
const LEGACY: Record<string, string> = {
  APPLE_ASC_KEY_ID: 'ASC_KEY_ID',
  APPLE_ASC_ISSUER_ID: 'ASC_ISSUER_ID',
  APPLE_ASC_KEY_P8_BASE64: 'ASC_KEY_P8_BASE64',
  APPLE_MATCH_PASSWORD: 'MATCH_PASSWORD',
  APPLE_MATCH_GIT_URL: 'MATCH_GIT_URL',
  APPLE_MATCH_GIT_BASIC_AUTHORIZATION: 'MATCH_GIT_BASIC_AUTHORIZATION',
  KEY_ALIAS: 'ANDROID_KEYSTORE_ALIAS',
  KEY_PASSWORD: 'ANDROID_KEYSTORE_PASSWORD',
}

function need(names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n]?.trim())
  if (missing.length) {
    const renames = Object.entries(LEGACY)
      .filter(([old, canon]) => missing.includes(canon) && process.env[old])
      .map(([old, canon]) => `${old} → ${canon}`)
    throw new KitError(
      `Missing release secrets: ${missing.join(', ')}`,
      renames.length
        ? `Rename in .env (PLAN §9.5): ${renames.join(', ')}; then \`kit env push --github\``
        : 'Add them to .env (or the CI job env)',
      ExitCode.config,
    )
  }
  const out: Record<string, string> = {}
  for (const n of names) {
    out[n] = process.env[n]!.trim()
    registerSecret(out[n])
  }
  return out
}

export interface AppleCreds {
  /** Env for lanes: ASC_*, MATCH_*, KIT_ASC_KEY_PATH. */
  env: Record<string, string>
  ascKeyPath: string
}

/** ASC API key (+ match when `match` is set). `MATCH_GIT_BASIC_AUTHORIZATION` is required in CI only. */
export function appleCreds(opts: { match: boolean; ci: boolean }): AppleCreds {
  const names = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_BASE64']
  if (opts.match) names.push('MATCH_PASSWORD', 'MATCH_GIT_URL')
  if (opts.match && opts.ci) names.push('MATCH_GIT_BASIC_AUTHORIZATION')
  const v = need(names)
  const ascKeyPath = decodeSecretFile('asc-key.p8', v.ASC_KEY_P8_BASE64!)
  if (!readFileSync(ascKeyPath, 'utf8').includes('-----BEGIN PRIVATE KEY-----')) {
    throw new KitError('ASC_KEY_P8_BASE64 does not decode to a .p8 private key', undefined, ExitCode.config)
  }
  const env: Record<string, string> = {
    ASC_KEY_ID: v.ASC_KEY_ID!,
    ASC_ISSUER_ID: v.ASC_ISSUER_ID!,
    KIT_ASC_KEY_PATH: ascKeyPath,
  }
  if (opts.match) {
    env.MATCH_PASSWORD = v.MATCH_PASSWORD!
    env.MATCH_GIT_URL = v.MATCH_GIT_URL!
    const basic = process.env.MATCH_GIT_BASIC_AUTHORIZATION?.trim()
    if (basic) {
      registerSecret(basic)
      env.MATCH_GIT_BASIC_AUTHORIZATION = basic
    }
  }
  return { env, ascKeyPath }
}

/** Play service account JSON → KIT_PLAY_JSON_KEY. */
export function playCreds(): Record<string, string> {
  const v = need(['PLAY_SERVICE_ACCOUNT_BASE64'])
  const path = decodeSecretFile('play.json', v.PLAY_SERVICE_ACCOUNT_BASE64!)
  if (!/"type"\s*:\s*"service_account"/.test(readFileSync(path, 'utf8'))) {
    throw new KitError(
      'PLAY_SERVICE_ACCOUNT_BASE64 does not decode to a Google service-account JSON',
      undefined,
      ExitCode.config,
    )
  }
  return { KIT_PLAY_JSON_KEY: path }
}

/**
 * Upload keystore → KIT_ANDROID_KEYSTORE_FILE. Alias and password stay in the inherited env as
 * ANDROID_KEYSTORE_ALIAS / _PASSWORD, where kit.release reads them (PLAN §13.4); never on argv.
 */
export function keystoreCreds(): Record<string, string> {
  const v = need(['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD'])
  // The alias is required but not secret: masking a word like "upload" would mangle every log line.
  if (!process.env.ANDROID_KEYSTORE_ALIAS?.trim()) {
    throw new KitError(
      'Missing release secrets: ANDROID_KEYSTORE_ALIAS',
      'Add it to .env (or the CI job env)',
      ExitCode.config,
    )
  }
  return { KIT_ANDROID_KEYSTORE_FILE: decodeSecretFile('release.keystore', v.ANDROID_KEYSTORE_BASE64!) }
}

/**
 * For `kit fastlane …` by hand: materialise whatever secret files the env allows, silently skipping
 * what isn't set. Lanes that need a missing one fail with fastlane's own message.
 */
export function optionalLaneCreds(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const n of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'MATCH_PASSWORD', 'MATCH_GIT_BASIC_AUTHORIZATION']) {
    registerSecret(process.env[n])
  }
  if (process.env.ASC_KEY_P8_BASE64?.trim()) {
    registerSecret(process.env.ASC_KEY_P8_BASE64)
    env.KIT_ASC_KEY_PATH = decodeSecretFile('asc-key.p8', process.env.ASC_KEY_P8_BASE64)
  }
  if (process.env.PLAY_SERVICE_ACCOUNT_BASE64?.trim()) {
    registerSecret(process.env.PLAY_SERVICE_ACCOUNT_BASE64)
    env.KIT_PLAY_JSON_KEY = decodeSecretFile('play.json', process.env.PLAY_SERVICE_ACCOUNT_BASE64)
  }
  return env
}
