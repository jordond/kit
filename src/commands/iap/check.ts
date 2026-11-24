import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Validate the in-app product file offline: schema, store limits, ids, screenshots',
  group: 'Release',
  examples: 'kit iap check\nkit iap check --json',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { runCheck } = await import('../../lib/iap/load')
    const { root, config } = requireProject(ctx)
    runCheck(root, config, ctx.flags, ctx.log)
  },
})
