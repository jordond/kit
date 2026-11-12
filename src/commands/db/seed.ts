import { defineCommand } from '../../cli/command'
import { dbArgs, remoteArg } from '../../lib/cloudflare'

export default defineCommand({
  description: "Run a D1 database's seed file (cloudflare.d1.<db>.seed; local by default)",
  group: 'Infra',
  args: { ...dbArgs, ...remoteArg },
  examples: 'kit db seed\nkit db seed --db analytics --remote',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { resolveD1, runD1, seedFile } = await import('../../lib/cloudflare')
    const { root, config } = requireProject(ctx)
    const file = seedFile(root, resolveD1(config, ctx.args.db))
    await runD1(ctx, { kind: 'exec', remote: !!ctx.args.remote, file }, { mutates: true })
  },
})
