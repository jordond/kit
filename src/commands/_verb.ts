import { relative } from 'node:path'
import pc from 'picocolors'
import { type KitContext, requireProject } from '../cli/command'
import type { KitConfig, Verb } from '../config/schema'
import { ExitCode, KitError } from '../lib/errors'
import { emitJson, log } from '../lib/log'
import { commandStep, printTimings, runSteps, type StepGroup, summarize } from '../lib/steps'
import {
  affectedTargets,
  type PlannedGroup,
  type PlanOptions,
  planVerbs,
  selectTargets,
} from '../lib/targets'

export interface VerbRun {
  /** Name shown in the summary (`check`, `lint --fix`). */
  name: string
  verbs: Verb[]
  plan?: Omit<PlanOptions, 'targets' | 'extra' | 'affected'>
  /** Shown under a failure. */
  hint?: string
}

/** What `--affected` resolved to. */
interface Affected {
  /** The ref compared against; null when none was found and every target runs. */
  base: string | null
  /** Changed files; undefined when the base was not found. */
  files?: string[]
  /** Affected targets among the selected ones, in config order. */
  targets: string[]
}

/** `--affected [--base <ref>]`: the changed files and the targets they select. Undefined without the flag. */
async function resolveAffected(
  ctx: KitContext,
  root: string,
  config: KitConfig,
): Promise<Affected | undefined> {
  const args = ctx.args as { affected?: boolean; base?: string; staged?: boolean }
  if (!args.affected) {
    if (args.base !== undefined) throw new KitError('--base needs --affected', undefined, ExitCode.usage)
    return undefined
  }
  if (args.staged) {
    throw new KitError(
      '--affected and --staged select targets differently; pick one',
      '--staged: what is in the index. --affected: everything changed since the base',
      ExitCode.usage,
    )
  }
  const selected = selectTargets(config, ctx.positionals).targets.map(([n]) => n)
  const { changedFiles } = await import('../lib/git')
  const changed = await changedFiles(root, args.base).catch(() => undefined)
  if (!changed) {
    // Never silently run nothing: without a base, everything counts as changed.
    log.warn(
      `--affected: ${args.base ? `base "${args.base}"` : 'no base (origin/HEAD, origin/main, main)'} not found; running every target`,
    )
    return { base: null, targets: selected }
  }
  const hit = new Set(affectedTargets(root, config, changed.files))
  return { base: changed.base, files: changed.files, targets: selected.filter((n) => hit.has(n)) }
}

/** Shared body of lint/format/typecheck/check/test/build: plan, run as a tree, summarize, exit code. */
export async function runVerb(ctx: KitContext, v: VerbRun): Promise<void> {
  const { root, config } = requireProject(ctx)
  if (config.cloudflare?.accountId) {
    // Verbs mostly don't touch wrangler: a missing account id is a warning here, fatal in deploy.
    try {
      ;(await import('../lib/cloudflare')).pinCloudflareAccount(root, config)
    } catch (e) {
      if (!(e instanceof KitError)) throw e
      log.warn(`${e.message}; CLOUDFLARE_ACCOUNT_ID not pinned`)
    }
  }
  const started = performance.now()
  const affected = await resolveAffected(ctx, root, config)
  /** `affected` and `base` in every `--json` document of an `--affected` run. */
  const selection = affected ? { affected: affected.targets, base: affected.base } : {}
  const groups = planVerbs(root, config, v.verbs, {
    ...v.plan,
    targets: ctx.positionals,
    extra: ctx.rest,
    affected: affected?.files,
  })
  const unchanged = affected?.files?.length === 0
  if (affected && !unchanged && !ctx.flags.json && !ctx.flags.quiet) {
    log.step(
      `affected: ${affected.targets.join(', ') || 'no target'}${affected.base ? ` (base ${affected.base})` : ''}`,
    )
  }

  if (ctx.flags.dryRun) {
    if (unchanged && !ctx.flags.json) log.info(`${v.name}: nothing affected since ${affected?.base}`)
    else printPlan(root, groups, ctx, selection)
    return
  }
  if (!groups.length) {
    if (ctx.flags.json) emitJson({ verb: v.name, ok: true, steps: [], ...selection })
    else if (unchanged) log.info(`${v.name}: nothing affected since ${affected?.base}`)
    else log.warn(`Nothing to ${v.name}${ctx.positionals.length ? ` for ${ctx.positionals.join(', ')}` : ''}`)
    return
  }

  const items: StepGroup[] = groups.map((g) => ({
    title: g.title,
    steps: g.commands.map((c) => commandStep(c.title, c.cmd, { cwd: c.cwd, env: c.env, mute: ctx.mute })),
  }))
  const results = await runSteps(items, ctx.flags, { bail: ctx.flags.bail })
  const code = ctx.flags.json
    ? results.every((r) => r.ok)
      ? 0
      : 1
    : summarize(v.name, results, started, v.hint)
  if (!ctx.flags.json && code !== ExitCode.interrupted) printTimings(results, ctx.flags)
  if (ctx.flags.json) {
    emitJson({
      verb: v.name,
      ok: code === 0,
      ms: Math.round(performance.now() - started),
      ...selection,
      steps: results.map((r) => ({
        target: r.group,
        title: r.title,
        ok: r.ok,
        ms: Math.round(r.ms),
        ...(r.ok ? {} : { error: r.error, output: tail(r.output) }),
      })),
    })
  }
  if (code) process.exitCode = code
}

const tail = (s: string | undefined, n = 50) => s?.split('\n').slice(-n).join('\n')

function printPlan(root: string, groups: PlannedGroup[], ctx: KitContext, selection: object): void {
  if (ctx.flags.json) {
    emitJson({
      ...selection,
      plan: groups.map((g) => ({
        target: g.title,
        commands: g.commands.map((c) => ({ cmd: c.cmd, cwd: relative(root, c.cwd) || '.' })),
      })),
    })
    return
  }
  for (const g of groups) {
    process.stderr.write(`${pc.bold(g.title)}\n`)
    for (const c of g.commands) {
      process.stderr.write(`  ${pc.dim(`${relative(root, c.cwd) || '.'} $`)} ${display(c.cmd)}\n`)
    }
  }
}

/** `sh -c <string>` shows as the string. */
const display = (cmd: string[]) =>
  cmd[0] === 'sh' && cmd[1] === '-c'
    ? cmd
        .slice(2)
        .filter((_a, i) => i !== 1)
        .join(' ')
    : cmd.join(' ')

/** One target for `dev` and `deploy`. */
export function singleTarget(ctx: KitContext, verb: string): string {
  const [name, ...more] = ctx.positionals
  if (!name || more.length) {
    const { config } = requireProject(ctx)
    throw new KitError(
      `kit ${verb} takes one target`,
      `Targets: ${Object.keys(config.targets).join(', ')}`,
      ExitCode.usage,
    )
  }
  return name
}
