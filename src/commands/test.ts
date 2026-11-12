import { defineCommand } from '../cli/command'
import { affectedArgs } from './_affected'

export default defineCommand({
  description: 'Run the test suites',
  group: 'Quality',
  args: affectedArgs,
  examples: 'kit test\nkit test api\nkit test client -- --rerun\nkit test --affected --base origin/develop',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    await runVerb(ctx, { name: 'test', verbs: ['test'] })
  },
})
