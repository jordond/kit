import type { KitConfig } from '../../config/schema'
import { trackChild } from '../cleanup'
import { parseSecretNames, wrangler, wranglerSecretPut } from '../cloudflare'
import { ExitCode, KitError } from '../errors'
import { childEnv } from '../proc'
import { type PipeResult, pipeSecret, redact } from '../secrets'
import type { EnvValues } from './schema'

/**
 * Push secrets to their remotes (ported from brewd `lib/env.ts` pushSecrets/pushGithubSecrets and
 * WhaleSay `_lib/wrangler-push.ts`): `wrangler secret put` per `env.workerSecrets[target]`, and
 * `gh secret set` for `env.githubSecrets`. Values go on stdin, never argv.
 *
 * Split in two so the command can show a summary and confirm once between them:
 * - `planPush` lists what is already set remotely (read-only) and classifies each key.
 * - `executePush` pushes the planned keys and stops at the first failure, so a bad credential
 *   doesn't fan out into N identical errors.
 * A remote whose list fails is skipped unless `proceedOnListFailure` (`--yes`): kit can't tell
 * what it would overwrite.
 */

export const GITHUB = 'github'

export interface ListResult {
  ok: boolean
  names: string[]
  /** First line of the failure, redacted. */
  error?: string
}

export interface Destination {
  /** Target name, or `github`. */
  name: string
  keys: string[]
  list(): Promise<ListResult>
  put(key: string, value: string): Promise<PipeResult>
}

export type PlanStatus = 'new' | 'overwrite' | 'unknown' | 'skipped-empty' | 'list-failed'

export interface PlannedDestination {
  destination: Destination
  listError?: string
  items: { key: string; status: PlanStatus }[]
}

export type PushStatus = 'pushed' | 'skipped-empty' | 'list-failed' | 'failed' | 'not-run'

export interface PushOutcome {
  destination: string
  key: string
  status: PushStatus
  /** Redacted child output on failure. */
  output?: string
}

export async function planPush(
  dest: Destination,
  values: EnvValues,
  opts: { proceedOnListFailure?: boolean } = {},
): Promise<PlannedDestination> {
  const listed = await dest.list()
  if (!listed.ok && !opts.proceedOnListFailure) {
    return {
      destination: dest,
      listError: listed.error,
      items: dest.keys.map((key) => ({ key, status: 'list-failed' })),
    }
  }
  const existing = new Set(listed.names)
  return {
    destination: dest,
    ...(listed.ok ? {} : { listError: listed.error }),
    items: dest.keys.map((key) => ({
      key,
      status: !values[key]
        ? 'skipped-empty'
        : !listed.ok
          ? 'unknown'
          : existing.has(key)
            ? 'overwrite'
            : 'new',
    })),
  }
}

const pushable = (s: PlanStatus) => s === 'new' || s === 'overwrite' || s === 'unknown'

export async function executePush(
  plans: PlannedDestination[],
  values: EnvValues,
  onPush: (dest: string, key: string) => void = () => {},
): Promise<PushOutcome[]> {
  const out: PushOutcome[] = []
  let failed = false
  for (const plan of plans) {
    const destination = plan.destination.name
    for (const { key, status } of plan.items) {
      if (!pushable(status)) {
        out.push({ destination, key, status: status as 'skipped-empty' | 'list-failed' })
        continue
      }
      if (failed) {
        out.push({ destination, key, status: 'not-run' })
        continue
      }
      onPush(destination, key)
      const r = await plan.destination.put(key, values[key] ?? '')
      if (r.code !== 0) {
        failed = true
        out.push({ destination, key, status: 'failed', output: redact(r.output) })
        continue
      }
      out.push({ destination, key, status: 'pushed' })
    }
  }
  return out
}

const firstLine = (s: string) => redact(s.trim().split('\n')[0] ?? '')

async function capture(
  cmd: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  trackChild(proc)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, stdout, stderr }
}

/** A worker target's secrets via wrangler, run from the target's dir. */
export function workerDestination(root: string, config: KitConfig, target: string): Destination {
  const keys = config.env?.workerSecrets?.[target]
  if (!keys) {
    const known = Object.keys(config.env?.workerSecrets ?? {})
    throw new KitError(
      `No env.workerSecrets for "${target}"`,
      known.length ? `Targets with secrets: ${known.join(', ')}` : 'Add env.workerSecrets in kit.config.ts',
      ExitCode.usage,
    )
  }
  return {
    name: target,
    keys,
    async list() {
      const w = wrangler(root, config, target, 'secret', 'list', '--format', 'json')
      const r = await capture(w.cmd, w.cwd)
      if (r.code !== 0) return { ok: false, names: [], error: firstLine(r.stderr || r.stdout) }
      return { ok: true, names: parseSecretNames(r.stdout) }
    },
    put(key, value) {
      return wranglerSecretPut(wrangler(root, config, target, 'secret', 'put', key), value)
    },
  }
}

/** GitHub Actions secrets via `gh`, run from the repo root (gh infers the repo from its remote). */
export function githubDestination(root: string, keys: string[]): Destination {
  return {
    name: GITHUB,
    keys,
    async list() {
      const r = await capture(['gh', 'secret', 'list', '--json', 'name'], root)
      if (r.code !== 0) return { ok: false, names: [], error: firstLine(r.stderr || r.stdout) }
      return { ok: true, names: parseSecretNames(r.stdout) }
    },
    put(key, value) {
      // gh uses stdin verbatim; a trailing newline would corrupt a token.
      return pipeSecret(['gh', 'secret', 'set', key], value, { cwd: root })
    },
  }
}
