import { defineCommand } from '../../cli/command'
import { dbArgs, remoteArg } from '../../lib/cloudflare'

export default defineCommand({
  description: 'List applied and pending D1 migrations',
  group: 'Infra',
  args: { ...dbArgs, ...remoteArg },
  examples: 'kit db list\nkit db list --remote --db analytics',
  async run(ctx) {
    const { runD1 } = await import('../../lib/cloudflare')
    await runD1(ctx, { kind: 'list', remote: !!ctx.args.remote }, { mutates: false })
  },
})
