import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Typecheck every target',
  group: 'Quality',
  examples: 'kit typecheck',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    await runVerb(ctx, { name: 'typecheck', verbs: ['typecheck'] })
  },
})
