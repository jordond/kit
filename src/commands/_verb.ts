import { relative } from 'node:path'
import pc from 'picocolors'
import { type KitContext, requireProject } from '../cli/command'
import type { Verb } from '../config/schema'
import { ExitCode, KitError } from '../lib/errors'
import { emitJson, log } from '../lib/log'
import { commandStep, runSteps, type StepGroup, summarize } from '../lib/steps'
import { type PlannedGroup, type PlanOptions, planVerbs } from '../lib/targets'

export interface VerbRun {
  /** Name shown in the summary (`check`, `lint --fix`). */
  name: string
  verbs: Verb[]
  plan?: Omit<PlanOptions, 'targets' | 'extra'>
  /** Shown under a failure. */
  hint?: string
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
  const groups = planVerbs(root, config, v.verbs, { ...v.plan, targets: ctx.positionals, extra: ctx.rest })

  if (ctx.flags.dryRun) {
    printPlan(root, groups, ctx)
    return
  }
  if (!groups.length) {
    if (ctx.flags.json) emitJson({ verb: v.name, ok: true, steps: [] })
    else log.warn(`Nothing to ${v.name}${ctx.positionals.length ? ` for ${ctx.positionals.join(', ')}` : ''}`)
    return
  }

  const items: StepGroup[] = groups.map((g) => ({
    title: g.title,
    steps: g.commands.map((c) => commandStep(c.title, c.cmd, { cwd: c.cwd, env: c.env })),
  }))
  const results = await runSteps(items, ctx.flags, { bail: ctx.flags.bail })
  const code = ctx.flags.json
    ? results.every((r) => r.ok)
      ? 0
      : 1
    : summarize(v.name, results, started, v.hint)
  if (ctx.flags.json) {
    emitJson({
      verb: v.name,
      ok: code === 0,
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

function printPlan(root: string, groups: PlannedGroup[], ctx: KitContext): void {
  if (ctx.flags.json) {
    emitJson({
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
