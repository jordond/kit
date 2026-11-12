import pc from 'picocolors'
import type { Flags } from '../../cli/command'
import type { Logger } from '../log'
import type { Check } from './checks'
import type { Entry } from './entries'
import { applyFix, type FixResult, fixable } from './fixes'

/**
 * The `--fix` pass of `kit doctor`: list the fixable checks, confirm once, apply each fix in
 * order, run the touched checks again, and say what each fix achieved. A fix counts as done only
 * when its check passes afterwards: a command that exits 0 and leaves the check failing (tools
 * installed by mise that this shell does not see yet) is reported as applied, not fixed.
 */

const passes = (check: Check | undefined) => !check || check.status === 'ok' || check.status === 'skip'

/**
 * `found` holds the result of each entry (same order) and is updated in place for the checks that
 * ran again. Returns one result per fixable check; empty when there was nothing to fix.
 */
export async function repair(o: {
  root: string
  entries: Entry[]
  found: (Check | undefined)[]
  /** Drop the shared probes before checks run again. */
  refresh: () => void
  flags: Pick<Flags, 'json' | 'dryRun' | 'yes' | 'interactive'>
  log: Logger
}): Promise<FixResult[]> {
  const { entries, found, flags, log } = o
  const todo = fixable(found.filter((c): c is Check => c !== undefined))
  if (!todo.length) return []
  const say = !flags.json
  if (say) {
    log.info(`${todo.length} fixable:`)
    for (const c of todo) log.step(`${c.label}  ${pc.dim(c.fix.description)}`)
  }

  let refused: string | undefined
  if (flags.dryRun) refused = 'dry run'
  else if (!flags.yes && !flags.interactive) refused = 'no terminal; re-run with --yes'
  else {
    const { confirm } = await import('../prompt')
    const n = todo.length
    if (!(await confirm(flags, `Apply ${n} fix${n === 1 ? '' : 'es'}?`, { initial: true }))) {
      refused = 'declined'
    }
  }
  if (refused !== undefined) {
    if (say) {
      log.warn(`Nothing fixed (${refused})`)
      log.info('')
    }
    return todo.map((c) => ({
      id: c.id,
      description: c.fix.description,
      applied: false,
      ok: flags.dryRun,
      ...(flags.dryRun ? {} : { error: refused }),
    }))
  }

  const fixes: FixResult[] = []
  const again = new Set<string>()
  for (const c of todo) {
    const r = await applyFix(o.root, c.id, c.fix)
    fixes.push(r)
    if (r.applied) for (const id of [c.id, ...(c.fix.rechecks ?? [])]) again.add(id)
  }
  // Only the checks a fix touched run again, on fresh probes.
  o.refresh()
  await Promise.all(
    entries.map(async (e, i) => {
      if (again.has(e.id)) found[i] = await e.run()
    }),
  )

  // The verdict comes from the check, not from the command's exit code.
  todo.forEach((c, i) => {
    const r = fixes[i]!
    const now = found[entries.findIndex((e) => e.id === c.id)]
    const still = r.applied && r.ok && !passes(now)
    if (still) {
      r.ok = false
      r.error = `${c.label} still ${now?.status === 'fail' ? 'fails' : 'warns'}: ${now?.detail ?? ''}`.trim()
      const hint = c.fix.after ?? now?.hint
      if (hint) r.hint = hint
    }
    if (!say) return
    if (r.ok) log.success(`fixed ${c.label}  ${pc.dim(r.description)}`)
    else if (!r.applied) log.warn(`skipped ${r.description}: ${r.error}`)
    else if (still) {
      log.warn(`applied ${r.description}, but ${r.error}`)
      if (r.hint) log.dim(`  › ${r.hint}`)
    } else log.error(`${r.description} failed`, r.error)
  })
  if (say) log.info('')
  return fixes
}
