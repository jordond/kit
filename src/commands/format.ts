import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Format every target',
  group: 'Quality',
  args: {
    check: { type: 'boolean', description: "Check only (runs each target's lint command)" },
    staged: {
      type: 'boolean',
      description: 'Only targets with staged files; workspace commands get the files',
    },
  },
  examples: 'kit format\nkit format client\nkit format --check',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    const staged = ctx.args.staged ? await (await import('../lib/git')).stagedFiles(ctx.root) : undefined
    await runVerb(ctx, {
      name: ctx.args.check ? 'format --check' : 'format',
      verbs: ctx.args.check ? ['lint'] : ['format'],
      plan: { staged },
      hint: ctx.args.check ? 'Run `kit format` to fix' : undefined,
    })
  },
})
