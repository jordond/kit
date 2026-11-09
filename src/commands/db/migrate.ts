import { defineCommand } from '../../cli/command'
import { dbArgs, remoteArg } from '../../lib/cloudflare'

export default defineCommand({
  description: 'Apply pending D1 migrations (local by default)',
  group: 'Infra',
  args: { ...dbArgs, ...remoteArg },
  examples: [
    'kit db migrate                 # the only database, or the default: true one',
    'kit db migrate --remote',
    'kit db migrate --db analytics --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { runD1 } = await import('../../lib/cloudflare')
    await runD1(ctx, { kind: 'migrate', remote: !!ctx.args.remote }, { mutates: true })
  },
})
