import { defineCommand } from '../cli/command'

/**
 * `kit env`: copy every key `.env.example` names and `.env` lacks into `.env`, with the example's
 * value (usually empty or a placeholder). A missing `.env` starts as a copy of the example. Existing
 * lines are never changed, nothing is asked, and no kit.config.ts is needed: it fixes what
 * `kit doctor` reports as missing. Only key names are printed.
 */
export default defineCommand({
  description: 'Copy keys missing from .env out of .env.example (never changes a set value)',
  group: 'Infra',
  examples: 'kit env\nkit env --dry-run\nkit env --json',
  async run(ctx) {
    const { fillEnv } = await import('../lib/env/init')
    const { emitJson } = await import('../lib/log')
    const { ExitCode, KitError } = await import('../lib/errors')
    const root = ctx.root ?? process.cwd()
    const plan = fillEnv(root, ctx.flags.dryRun)
    if (!plan) {
      throw new KitError(
        'No .env.example here',
        'kit env copies keys from .env.example into .env; add one, or run `kit env init`',
        ExitCode.config,
      )
    }

    if (ctx.flags.json) {
      emitJson({ dryRun: ctx.flags.dryRun, created: plan.created, added: plan.added })
      return
    }
    const would = ctx.flags.dryRun ? 'would ' : ''
    if (plan.created) ctx.log.success(`${would}create .env from .env.example`)
    else if (plan.added.length) ctx.log.success(`${would}add ${plan.added.join(', ')} to .env`)
    else {
      ctx.log.success('.env has every key in .env.example')
      return
    }
    if (!ctx.flags.dryRun) ctx.log.dim('  › set their values in .env')
  },
})
