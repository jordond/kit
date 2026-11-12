import { defineCommand } from '../cli/command'
import { suiteArgs } from '../lib/maestro/args'

export default defineCommand({
  description: 'Capture screenshots with the Maestro flows: 9:41 status bar, fixture, PNGs',
  group: 'Quality',
  examples:
    'kit shots android\nkit shots ios --full\nkit shots ipad --no-build --out brand/screenshots/ipad\nkit shots android --dry-run --json',
  args: {
    ...suiteArgs,
    full: { type: 'boolean', description: 'Run the shots-full suite (define it under maestro.suites)' },
    out: { type: 'string', description: 'Copy the screenshots here instead of the suite dir (used as is)' },
  },
  async run(ctx) {
    const { requireFullSuite, runSuiteCommand } = await import('../lib/maestro/command')
    const full = ctx.args.full === true
    if (full && ctx.args.suite) {
      const { ExitCode, KitError } = await import('../lib/errors')
      throw new KitError('--full and --suite conflict', '--full is --suite shots-full', ExitCode.usage)
    }
    if (full) requireFullSuite(ctx)
    await runSuiteCommand(ctx, {
      command: 'shots',
      defaultSuite: full ? 'shots-full' : 'shots',
      out: ctx.args.out,
    })
  },
})
