import type { KitConfig } from '../../config/schema'
import { LEGACY, onGitHubActions, RETIRED, releaseSecrets } from '../release/creds'
import { githubDestination } from './push'

/**
 * Do the repo's GitHub Actions secrets hold every name CI needs? Names only: `gh secret list`
 * never returns values. Expected = `env.githubSecrets` plus the canonical release secrets for the
 * configured platforms (PLAN §9.5).
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

export function expectedGithubSecrets(config: KitConfig): { required: string[]; optional: string[] } {
  const r = releaseSecrets(config)
  const required = [...new Set([...(config.env?.githubSecrets ?? []), ...r.required, ...r.ci])]
  return { required, optional: r.optional.filter((n) => !required.includes(n)) }
}

export function compareGithubSecrets(
  expected: { required: string[]; optional: string[] },
  present: string[],
): Omit<GithubSecretsCheck, 'reason'> {
  const has = new Set(present)
  const missing = expected.required.filter((n) => !has.has(n))
  const stale = present.filter((n) => n in LEGACY || RETIRED.includes(n)).sort()
  return {
    status: missing.length ? 'missing' : 'ok',
    expected: expected.required,
    missing,
    optionalMissing: expected.optional.filter((n) => !has.has(n)),
    stale,
  }
}

export async function checkGithubSecrets(root: string, config: KitConfig): Promise<GithubSecretsCheck> {
  const expected = expectedGithubSecrets(config)
  const skipped = (reason: string): GithubSecretsCheck => ({
    status: 'skipped',
    reason,
    expected: expected.required,
    missing: [],
    optionalMissing: [],
    stale: [],
  })
  if (!expected.required.length && !expected.optional.length) return skipped('no GitHub secrets expected')
  // A job's token can't list repo secrets, and the job's env already shows what it was given.
  if (onGitHubActions()) return skipped('running on GitHub Actions')
  if (!Bun.which('gh')) return skipped('gh not installed')
  const listed = await githubDestination(root, []).list()
  if (!listed.ok) return skipped(`gh secret list failed: ${listed.error ?? 'unknown error'}`)
  return compareGithubSecrets(expected, listed.names)
}
