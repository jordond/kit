import { createPrivateKey, sign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Flags } from '../../cli/command'
import { setKey } from '../env/init'
import { githubDestination } from '../env/push'
import { parseDotenv, writeAtomic } from '../env/render'
import { ExitCode, KitError } from '../errors'
import { runPiped } from '../proc'
import { confirm } from '../prompt'
import { redact, registerSecret } from '../secrets'

/**
 * Shared by `kit release setup android|ios`: read and write release secrets in the root `.env`, set
 * them as GitHub Actions secrets, and check the iOS ones against their services before they are stored.
 */

/** `.env` text, or '' when there is none. */
export function readDotenv(root: string): string {
  const file = join(root, '.env')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** Non-empty values of `.env`. */
export function dotenvValues(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parseDotenv(readDotenv(root), 'env'))) if (v.trim()) out[k] = v.trim()
  return out
}

/** Write `values` into `.env` (0600), keeping every other line. */
export function writeEnvSecrets(root: string, values: Record<string, string>): void {
  if (!Object.keys(values).length) return
  let text = readDotenv(root)
  for (const [k, v] of Object.entries(values)) text = setKey(text, k, v)
  if (!text.endsWith('\n')) text += '\n'
  writeAtomic(join(root, '.env'), text)
}

/**
 * Whether to set GitHub Actions secrets: `--github` / `--no-github` decide; otherwise kit asks in a
 * terminal (`--yes` answers yes) and skips elsewhere. Fails early when gh is needed and missing.
 */
export async function decideGithub(
  flags: Flags,
  arg: boolean | undefined,
  what: string,
): Promise<boolean | undefined> {
  let github = arg
  if (github === undefined && !flags.dryRun) {
    github =
      flags.interactive || flags.yes
        ? await confirm(flags, `Set ${what} as GitHub Actions secrets?`, { initial: true })
        : false
  }
  if (github && !Bun.which('gh')) {
    throw new KitError('gh not found', 'Install the GitHub CLI, or pass --no-github', ExitCode.config)
  }
  return github
}

export interface GithubPush {
  pushed: string[]
  /** First line of gh's failure; the names after it were not tried. */
  error?: string
}

/** `gh secret set` for each value, on stdin; stops at the first failure. */
export async function pushGithub(root: string, values: Record<string, string>): Promise<GithubPush> {
  const dest = githubDestination(root, Object.keys(values))
  const pushed: string[] = []
  for (const key of dest.keys) {
    const r = await dest.put(key, values[key]!)
    if (r.code !== 0) {
      return {
        pushed,
        error: r.output.trim().split('\n')[0] || `gh secret set ${key} failed (exit ${r.code})`,
      }
    }
    pushed.push(key)
  }
  return { pushed }
}

/** Throws after everything else was reported: `.env` is written, GitHub is not complete. */
export function assertPushed(push: GithubPush, names: string[]): void {
  if (!push.error) return
  const rest = names.filter((k) => !push.pushed.includes(k))
  throw new KitError(
    `GitHub Actions secrets not fully set: ${push.error}`,
    `.env is written. Set the rest by hand: ${rest.join(', ')}`,
  )
}

// ---- Play ---------------------------------------------------------------------------------------

/** A Google service-account JSON file as base64. */
export function playServiceAccount(file: string): string {
  if (!existsSync(file)) throw new KitError(`${file} not found`, undefined, ExitCode.usage)
  const bytes = readFileSync(file)
  if (!/"type"\s*:\s*"service_account"/.test(bytes.toString('utf8'))) {
    throw new KitError(
      `${file} is not a Google service-account JSON`,
      'Download the JSON key of the service account that has access to the app in Play Console',
      ExitCode.usage,
    )
  }
  return bytes.toString('base64')
}

// ---- App Store Connect --------------------------------------------------------------------------

export const ISSUER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const KEY_ID_RE = /^[A-Z0-9]{8,12}$/

/** `AuthKey_<id>.p8` → `<id>`: the name Apple gives the download. */
export const keyIdFromFile = (file: string): string | undefined =>
  /^AuthKey_([A-Z0-9]+)\.p8$/.exec(basename(file))?.[1]

/** A `.p8` file as base64; fails unless it holds a private key. */
export function ascKeyFile(file: string): string {
  if (!existsSync(file)) throw new KitError(`${file} not found`, undefined, ExitCode.usage)
  const text = readFileSync(file, 'utf8')
  if (!text.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new KitError(
      `${file} is not a .p8 private key`,
      'Use the AuthKey_<id>.p8 downloaded from App Store Connect (Users and Access → Integrations)',
      ExitCode.usage,
    )
  }
  return Buffer.from(text).toString('base64')
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url')

/** An App Store Connect API token (ES256, 5 minutes). */
export function ascToken(keyId: string, issuerId: string, p8: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 300, aud: 'appstoreconnect-v1' }))
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(p8),
    dsaEncoding: 'ieee-p1363',
  })
  return `${head}.${body}.${b64url(signature)}`
}

export type Verified = 'ok' | 'unreachable' | 'skipped'

const ASC_API = 'https://api.appstoreconnect.apple.com'

/**
 * Does App Store Connect accept the key? `ok`, or `unreachable` when the request itself fails (offline);
 * a rejection (401/403) throws, so a wrong key id or issuer never reaches `.env`.
 */
export async function verifyAscKey(keyId: string, issuerId: string, p8Base64: string): Promise<Verified> {
  let token: string
  try {
    token = ascToken(keyId, issuerId, Buffer.from(p8Base64, 'base64').toString('utf8'))
  } catch {
    throw new KitError('The .p8 is not a usable EC private key', undefined, ExitCode.usage)
  }
  registerSecret(token)
  const base = process.env.KIT_ASC_API_URL || ASC_API
  let res: Response
  try {
    res = await fetch(`${base}/v1/apps?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return 'unreachable'
  }
  if (res.status === 401 || res.status === 403) {
    throw new KitError(
      `App Store Connect rejected the API key (HTTP ${res.status})`,
      'Check the key id, the issuer id and that the .p8 belongs to them; the key needs App Manager access',
      ExitCode.config,
    )
  }
  return res.ok ? 'ok' : 'unreachable'
}

/** Can this machine read the match repo? Never prompts; a failure is reported, not fatal. */
export async function verifyMatchRepo(root: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const r = await runPiped(['git', 'ls-remote', '--heads', url], {
    cwd: root,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10' },
  })
  if (r.code === 0) return { ok: true }
  return { ok: false, error: redact(r.stderr.trim().split('\n')[0] ?? `git ls-remote exit ${r.code}`) }
}

/** `MATCH_GIT_BASIC_AUTHORIZATION`: base64 of `user:token`. */
export const basicAuthorization = (user: string, token: string): string =>
  Buffer.from(`${user}:${token}`).toString('base64')
