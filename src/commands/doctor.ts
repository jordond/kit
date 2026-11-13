import { defineCommand } from '../cli/command'

/**
 * `kit doctor`: one line per check on stderr (✔ ok, ▲ warning, ✖ failure), `--json` on stdout.
 * The rules are pure functions (src/lib/doctor/checks.ts) over what src/lib/doctor/entries.ts
 * probes. A tool the project needs fails; one it doesn't need only warns. Any failure exits 4.
 *
 * `--fix` applies the repairs some checks carry (src/lib/doctor/repair.ts) after one confirmation,
 * runs those checks again, and reports the state after the fixes.
 */

export * from '../lib/doctor/checks'

export default defineCommand({
  description: 'Check tools, versions and .env',
  group: 'Setup',
  args: {
    ci: { type: 'boolean', description: 'Fail when CI workflow pins drift from the package.json pin' },
    fix: { type: 'boolean', description: 'Apply the safe, local fixes, then check again' },
  },
  examples: 'kit doctor\nkit doctor --json\nkit doctor --ci\nkit doctor --fix\nkit doctor --fix --dry-run',
  async run(ctx) {
    const pc = (await import('picocolors')).default
    const { ExitCode } = await import('../lib/errors')
    const { doctorEntries } = await import('../lib/doctor/entries')
    const { describeFix, fixable } = await import('../lib/doctor/fixes')
    const { emitJson } = await import('../lib/log')

    const root = ctx.root ?? process.cwd()
    const { entries, refresh } = doctorEntries(root, ctx.config, { strictCi: ctx.args.ci === true })
    // oxlint-disable-next-line typescript/await-thenable -- a check may answer synchronously or with a promise
    const found = await Promise.all(entries.map((e) => e.run()))
    const wantFix = ctx.args.fix === true
    const fixes = wantFix
      ? await (
          await import('../lib/doctor/repair')
        ).repair({
          root,
          entries,
          found,
          refresh,
          flags: ctx.flags,
          log: ctx.log,
        })
      : []

    const checks = found.filter((c) => c !== undefined)
    const ok = !checks.some((c) => c.status === 'fail')
    if (ctx.flags.json) {
      emitJson({
        ok,
        checks: checks.map((c) => (c.fix ? { ...c, fix: describeFix(c.fix) } : c)),
        ...(wantFix ? { fixes } : {}),
      })
    } else {
      const width = Math.max(...checks.map((c) => c.label.length)) + 2
      for (const c of checks) {
        const line = `${c.label.padEnd(width)}${pc.dim(c.detail ?? '')}`
        if (c.status === 'ok') ctx.log.success(line)
        else if (c.status === 'warn') {
          ctx.log.warn(line)
          if (c.hint) ctx.log.dim(`  › ${c.hint}`)
        } else if (c.status === 'fail') ctx.log.error(line, c.hint)
        else if (!ctx.flags.quiet) ctx.log.dim(`- ${line}`)
      }
      const left = fixable(checks).length
      if (left && !wantFix) ctx.log.dim(`${left} fixable with \`kit doctor --fix\``)
    }
    if (!ok) process.exitCode = ExitCode.precondition
  },
})
