import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Run the test suites',
  group: 'Quality',
  examples: 'kit test\nkit test api\nkit test client -- --rerun',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    await runVerb(ctx, { name: 'test', verbs: ['test'] })
  },
})
