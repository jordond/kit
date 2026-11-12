import type { Flags } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import { pinCloudflareAccount } from '../cloudflare'
import { ExitCode, KitError } from '../errors'
import type { Logger } from '../log'
import { confirm } from '../prompt'
import { executePush, githubDestination, type PlannedDestination, planPush, workerDestination } from './push'
import type { EnvValues } from './schema'

/**
 * One `kit env push` run: pick destinations, list, summarise, confirm, push. Shared by
 * `kit env push` and `kit env rotate --push`, so both follow the same listing and failure rules.
 * Split into a read-only preflight and the puts, so `rotate` can preflight before it writes `.env`.
 * Prints names and statuses only (to stderr, and not at all under --json); the caller writes the
 * JSON document and sets the exit code from the report.
 */

/** Which remotes a push covers; mirrors the `kit env push` flags. */
export interface PushSelection {
  /** One worker target. */
  target?: string
  /** GitHub Actions secrets. Alone: GitHub only. With `target`: both. */
  github?: boolean
  /** Every worker, GitHub skipped. */
  workers?: boolean
  /** Every worker and GitHub: the same as an empty selection. */
  all?: boolean
}

export interface PushReport {
  ok: boolean
  dryRun: boolean
  /** `output` is the redacted child output of a failed put. */
  outcomes: { destination: string; key: string; status: string; output?: string }[]
}

type PushCtx = { flags: Flags; log: Logger }

/** The read-only half of a push: the remotes listed and every key classified. Nothing is written yet. */
export interface PushPreflight {
  plans: PlannedDestination[]
  /** How many keys would be put. */
  count: number
  /** Remotes kit could not list (and `--yes` was not given). */
  listFailed: string[]
}

/** Usage error (exit 2) for flags that contradict each other. */
export function assertSelection(sel: PushSelection): void {
  const clash = (a: string, b: string, hint: string): never => {
    throw new KitError(`--${a} and --${b} are exclusive`, hint, ExitCode.usage)
  }
  if (sel.all && sel.target) clash('all', 'target', 'kit env push --all')
  if (sel.workers && sel.all) clash('workers', 'all', 'kit env push --workers')
  if (sel.workers && sel.target) clash('workers', 'target', 'kit env push --workers')
  if (sel.workers && sel.github)
    clash('workers', 'github', 'Bare `kit env push` covers every worker and GitHub')
}

/** The `kit env push …` command line for a selection. */
export function pushCommand(sel: PushSelection): string {
  const parts = ['kit', 'env', 'push']
  if (sel.target) parts.push('--target', sel.target)
  if (sel.workers) parts.push('--workers')
  if (sel.github) parts.push('--github')
  return parts.join(' ')
}

/** Join the preflights of several selections, so one confirm and one push cover them all. */
export function mergePreflights(list: PushPreflight[]): PushPreflight {
  return {
    plans: list.flatMap((p) => p.plans),
    count: list.reduce((n, p) => n + p.count, 0),
    listFailed: list.flatMap((p) => p.listFailed),
  }
}

/** Pick the destinations, pin the Cloudflare account, list each remote and print the summary. */
export async function preflightPush(
  ctx: PushCtx,
  root: string,
  config: KitConfig,
  values: EnvValues,
  sel: PushSelection,
  /** `strict`: a remote that cannot be listed is a failure even with `--yes` (rotate must not write first). */
  opts: { strict?: boolean } = {},
): Promise<PushPreflight> {
  assertSelection(sel)
  // No flags (or --all): every worker and GitHub (when env.githubSecrets is set).
  // --target: that worker. --github alone: GitHub only. Both: that worker and GitHub.
  // --workers: every worker, GitHub skipped.
  const everything = sel.all || (!sel.target && !sel.github && !sel.workers)
  const workerNames = sel.target
    ? [sel.target]
    : everything || sel.workers
      ? Object.keys(config.env?.workerSecrets ?? {})
      : []
  const destinations = workerNames.map((t) => workerDestination(root, config, t))
  if (everything && config.env?.githubSecrets?.length) {
    destinations.push(githubDestination(root, config.env.githubSecrets))
  } else if (sel.github && !everything) {
    const keys = config.env?.githubSecrets ?? []
    if (!keys.length) {
      throw new KitError(
        'No env.githubSecrets configured',
        'Add env.githubSecrets in kit.config.ts',
        ExitCode.usage,
      )
    }
    destinations.push(githubDestination(root, keys))
  }
  if (!destinations.length) {
    throw new KitError(
      'Nothing to push',
      sel.workers
        ? 'Add env.workerSecrets in kit.config.ts'
        : 'Add env.workerSecrets or env.githubSecrets in kit.config.ts',
      ExitCode.usage,
    )
  }
  if (workerNames.length) pinCloudflareAccount(root, config)

  const proceedOnListFailure = !opts.strict && ctx.flags.yes
  const plans: PlannedDestination[] = []
  for (const d of destinations) plans.push(await planPush(d, values, { proceedOnListFailure }))
  const count = plans.flatMap((p) =>
    p.items.filter((i) => i.status === 'new' || i.status === 'overwrite' || i.status === 'unknown'),
  ).length
  // A remote kit could not list (bad wrangler or gh auth) is a failure, even if nothing else is left to push.
  const listFailed = plans
    .filter((p) => p.items.some((i) => i.status === 'list-failed'))
    .map((p) => p.destination.name)

  if (!ctx.flags.json) {
    for (const p of plans) {
      ctx.log.info(p.destination.name)
      if (p.listError) ctx.log.warn(`could not list existing secrets: ${p.listError}`)
      for (const i of p.items) ctx.log.dim(`  ${i.key}  ${i.status}`)
    }
    if (listFailed.length && !opts.strict)
      ctx.log.warn('Skipping remotes kit could not list; re-run with --yes to push anyway')
  }
  return { plans, count, listFailed }
}

/** The mutating half: put every planned key, stopping at the first failure. It does not confirm. */
export async function executePreflight(
  ctx: PushCtx,
  pre: PushPreflight,
  values: EnvValues,
): Promise<PushReport> {
  const { plans, listFailed } = pre
  const failListed = () => {
    if (listFailed.length && !ctx.flags.json) {
      ctx.log.error(`could not list secrets on ${listFailed.join(', ')}`)
    }
  }

  if (ctx.flags.dryRun || !pre.count) {
    if (!ctx.flags.json && !pre.count && !listFailed.length) ctx.log.warn('Nothing to push')
    failListed()
    return {
      ok: !listFailed.length,
      dryRun: ctx.flags.dryRun,
      outcomes: plans.flatMap((p) =>
        p.items.map((i) => ({ destination: p.destination.name, key: i.key, status: i.status })),
      ),
    }
  }

  const outcomes = await executePush(plans, values, (dest, key) => {
    if (!ctx.flags.json) ctx.log.step(`${key} → ${dest}`)
  })
  const failed = outcomes.find((o) => o.status === 'failed')
  if (failed) {
    if (!ctx.flags.json) {
      ctx.log.error(`push ${failed.key} → ${failed.destination} failed`)
      if (failed.output?.trim()) process.stderr.write(`${failed.output.trim()}\n`)
    }
    return { ok: false, dryRun: ctx.flags.dryRun, outcomes }
  }
  if (!ctx.flags.json) {
    const pushed = outcomes.filter((o) => o.status === 'pushed').length
    ctx.log.success(`pushed ${pushed}, skipped ${outcomes.length - pushed}`)
  }
  failListed()
  return { ok: !listFailed.length, dryRun: ctx.flags.dryRun, outcomes }
}

export async function runPush(
  ctx: PushCtx,
  root: string,
  config: KitConfig,
  values: EnvValues,
  sel: PushSelection,
): Promise<PushReport> {
  const pre = await preflightPush(ctx, root, config, values, sel)
  if (!ctx.flags.dryRun && pre.count) {
    const where = pre.plans.map((p) => p.destination.name).join(', ')
    if (!(await confirm(ctx.flags, `Push ${pre.count} secret(s) to ${where}?`))) {
      throw new KitError('Cancelled', undefined, ExitCode.interrupted)
    }
  }
  return executePreflight(ctx, pre, values)
}
