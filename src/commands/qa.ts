import { defineCommand } from '../cli/command'
import { suiteArgs } from '../lib/maestro/args'

export default defineCommand({
  description: 'Run the Maestro flows on a device: build, install, fixture, flows',
  group: 'Quality',
  examples:
    'kit qa android\nkit qa ios --suite smoke --no-build\nkit qa android --tags auth,smoke --junit reports/qa.xml\nkit qa ios --dry-run --json',
  args: {
    ...suiteArgs,
    tags: { type: 'string', description: "Run these tags as one stage, replacing the suite's stages" },
    junit: { type: 'string', description: 'Write a JUnit report here (several stages: <name>-2.xml, …)' },
  },
  async run(ctx) {
    const { runSuiteCommand } = await import('../lib/maestro/command')
    await runSuiteCommand(ctx, {
      command: 'qa',
      defaultSuite: 'qa',
      tags: ctx.args.tags,
      junit: ctx.args.junit,
    })
  },
})
