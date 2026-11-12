import { defineCommand } from '../cli/command'
import { affectedArgs } from './_affected'

export default defineCommand({
  description: 'Typecheck every target',
  group: 'Quality',
  args: affectedArgs,
  examples: 'kit typecheck',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    await runVerb(ctx, { name: 'typecheck', verbs: ['typecheck'] })
  },
})
