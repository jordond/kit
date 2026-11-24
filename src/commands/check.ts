import { defineCommand } from '../cli/command'
import { affectedArgs } from './_affected'

export default defineCommand({
  description: 'Lint and typecheck every target',
  group: 'Quality',
  args: {
    ...affectedArgs,
    fix: { type: 'boolean', short: 'f', description: 'Format instead of lint, then typecheck' },
    codegen: {
      type: 'boolean',
      description: 'Also run codegen and fail when its outputs are not committed (always on in CI)',
    },
  },
  examples: 'kit check\nkit check api admin web\nkit check --fix\nkit check --affected\nkit check --codegen',
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { runVerb } = await import('./_verb')
    const { config, root } = requireProject(ctx)
    const drift =
      !ctx.args.fix && !ctx.flags.dryRun && (ctx.args.codegen === true || (ctx.flags.ci && !!config.codegen))
    await runVerb(ctx, {
      name: ctx.args.fix ? 'check --fix' : 'check',
      verbs: ctx.args.fix ? ['format', 'typecheck'] : ['lint', 'typecheck'],
      hint: ctx.args.fix ? undefined : 'Run `kit check --fix` to fix what the tools can',
    })
    if (drift && !process.exitCode) {
      const { assertNoDrift, requireCodegen, runCodegen } = await import('../lib/codegen')
      const codegen = requireCodegen(config)
      if (await runCodegen(root, codegen, ctx.flags)) await assertNoDrift(root, codegen.outputs)
    }
  },
})
