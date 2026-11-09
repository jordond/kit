import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Lint and typecheck every target',
  group: 'Quality',
  args: {
    fix: { type: 'boolean', short: 'f', description: 'Format instead of lint, then typecheck' },
  },
  examples: 'kit check\nkit check api admin web\nkit check --fix',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    await runVerb(ctx, {
      name: ctx.args.fix ? 'check --fix' : 'check',
      verbs: ctx.args.fix ? ['format', 'typecheck'] : ['lint', 'typecheck'],
      hint: ctx.args.fix ? undefined : 'Run `kit check --fix` to fix what the tools can',
    })
  },
})
