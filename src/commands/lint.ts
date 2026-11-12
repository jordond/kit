import { defineCommand } from '../cli/command'
import { affectedArgs } from './_affected'

export default defineCommand({
  description: 'Lint every target',
  group: 'Quality',
  args: {
    ...affectedArgs,
    fix: { type: 'boolean', short: 'f', description: "Apply fixes (runs each target's format command)" },
    staged: {
      type: 'boolean',
      description: 'Only targets with staged files; workspace commands get the files',
    },
  },
  examples: 'kit lint\nkit lint api web\nkit lint --staged --fix',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    const staged = ctx.args.staged ? await (await import('../lib/git')).stagedFiles(ctx.root) : undefined
    await runVerb(ctx, {
      name: ctx.args.fix ? 'lint --fix' : 'lint',
      verbs: ctx.args.fix ? ['format'] : ['lint'],
      plan: { staged },
      hint: ctx.args.fix ? undefined : 'Run `kit lint --fix` to fix what the tools can',
    })
  },
})
