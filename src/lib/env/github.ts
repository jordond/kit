import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KitConfig } from '../../config/schema'
import { runPiped } from '../proc'
import { LEGACY, onGitHubActions, RETIRED, releaseSecrets } from '../release/creds'
import { githubDestination } from './push'

/**
 * Do the repo's GitHub Actions secrets hold every name CI needs? Names only: `gh` never returns
 * values. Expected = `env.githubSecrets`, plus the canonical release secrets for the configured
 * platforms (PLAN §9.5) when a workflow releases (calls mobile-distribute.yml or runs
 * `kit release`); a repo that releases only from a laptop needs none of them on GitHub.
 * Present = repo secrets, plus environment secrets (`production`, §9.6) and org secrets shared
 * with the repo, when gh can read them.
 */

export interface GithubSecretsCheck {
  status: 'ok' | 'missing' | 'skipped'
  /** Why the comparison didn't run (no gh, not authenticated, on GitHub Actions, nothing expected). */
  reason?: string
  expected: string[]
  missing: string[]
  /** Optional names (SENTRY_AUTH_TOKEN) that are absent: a warning, not a failure. */
  optionalMissing: string[]
  /** Old or retired names still present: delete them once CI uses the canonical ones. */
  stale: string[]
}

export function expectedGithubSecrets(
  config: KitConfig,
  ciReleases = true,
): { required: string[]; optional: string[] } {
  const r = ciReleases ? releaseSecrets(config) : { required: [], ci: [], optional: [] }
  const required = [...new Set([...(config.env?.githubSecrets ?? []), ...r.required, ...r.ci])]
  return { required, optional: r.optional.filter((n) => !required.includes(n)) }
}

export function compareGithubSecrets(
  expected: { required: string[]; optional: string[] },
  present: string[],
): Omit<GithubSecretsCheck, 'reason'> {
  const has = new Set(present)
  const missing = expected.required.filter((n) => !has.has(n))
  const stale = present.filter((n) => Object.hasOwn(LEGACY, n) || RETIRED.includes(n)).sort()
  return {
    status: missing.length ? 'missing' : 'ok',
    expected: expected.required,
    missing,
    optionalMissing: expected.optional.filter((n) => !has.has(n)),
    stale,
  }
}

const RELEASES = /mobile-distribute\.yml|\bkit\s+release\b/

/** Does any workflow under .github/workflows release with kit? */
export function workflowsRelease(root: string): boolean {
  const dir = join(root, '.github', 'workflows')
  if (!existsSync(dir)) return false
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .some((f) => RELEASES.test(readFileSync(join(dir, f), 'utf8')))
}

async function ghJson(root: string, args: string[]): Promise<unknown> {
  const r = await runPiped(['gh', ...args], { cwd: root })
  if (r.code !== 0) return undefined
  try {
    return JSON.parse(r.stdout)
  } catch {
    return undefined
  }
}

/** `[{ name }]` → names; anything else → none. */
const nameList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => (x as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string')
    : []

/** `{ [key]: [{ name }] }` → names. */
const names = (v: unknown, key: string): string[] =>
  v && typeof v === 'object' && !Array.isArray(v) ? nameList((v as Record<string, unknown>)[key]) : []

/** Environment and org secrets visible to the repo; best effort (a missing scope just adds none). */
async function sharedSecretNames(root: string): Promise<string[]> {
  const [envs, org] = await Promise.all([
    ghJson(root, ['api', 'repos/{owner}/{repo}/environments']),
    ghJson(root, ['api', 'repos/{owner}/{repo}/actions/organization-secrets']),
  ])
  const perEnv = await Promise.all(
    names(envs, 'environments').map(async (env) => {
      return nameList(await ghJson(root, ['secret', 'list', '--env', env, '--json', 'name']))
    }),
  )
  return [...names(org, 'secrets'), ...perEnv.flat()]
}

export function skippedGithub(reason: string, expected: string[] = []): GithubSecretsCheck {
  return { status: 'skipped', reason, expected, missing: [], optionalMissing: [], stale: [] }
}

export async function checkGithubSecrets(root: string, config: KitConfig): Promise<GithubSecretsCheck> {
  const expected = expectedGithubSecrets(config, workflowsRelease(root))
  const skipped = (reason: string) => skippedGithub(reason, expected.required)
  if (!expected.required.length && !expected.optional.length) return skipped('no GitHub secrets expected')
  // A job's token can't list repo secrets, and the job's env already shows what it was given.
  if (onGitHubActions()) return skipped('running on GitHub Actions')
  if (!Bun.which('gh')) return skipped('gh not installed')
  const listed = await githubDestination(root, []).list()
  if (!listed.ok) return skipped(`gh secret list failed: ${listed.error ?? 'unknown error'}`)
  const missingRepo = expected.required.filter((n) => !listed.names.includes(n))
  const shared = missingRepo.length ? await sharedSecretNames(root) : []
  return compareGithubSecrets(expected, [...new Set([...listed.names, ...shared])])
}
