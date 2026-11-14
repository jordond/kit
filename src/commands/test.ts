import { defineCommand } from '../cli/command'
import { affectedArgs } from './_affected'
import { scopeArgs } from './_scope'

export default defineCommand({
  description: 'Run the test suites',
  group: 'Quality',
  args: { ...affectedArgs, ...scopeArgs },
  examples:
    'kit test\nkit test api\nkit test client -- --rerun\nkit test -m core -p jvm\nkit test --affected --base origin/develop',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    const { resolveScope } = await import('./_scope')
    const scope = await resolveScope(ctx)
    await runVerb(ctx, { name: 'test', verbs: ['test'], targets: scope.targets, plan: scope.plan })
  },
})
