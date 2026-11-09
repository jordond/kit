import { defineCommand } from '../../cli/command'
import { dbArgs, remoteArg } from '../../lib/cloudflare'

export default defineCommand({
  description: 'Apply pending D1 migrations (local by default)',
  group: 'Infra',
  args: { ...dbArgs, ...remoteArg },
  examples: 'kit db migrate\nkit db migrate --remote\nkit db migrate --db analytics --dry-run',
  async run(ctx) {
    const { runD1 } = await import('../../lib/cloudflare')
    await runD1(ctx, { kind: 'migrate', remote: !!ctx.args.remote }, { mutates: true })
  },
})
