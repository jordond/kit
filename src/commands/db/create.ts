import { defineCommand } from '../../cli/command'
import { dbArgs } from '../../lib/cloudflare'

export default defineCommand({
  description: 'Create a new D1 migration file',
  group: 'Infra',
  args: { ...dbArgs },
  examples: 'kit db create add_widgets\nkit db create add_events --db analytics',
  async run(ctx) {
    const { runD1 } = await import('../../lib/cloudflare')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const migration = ctx.positionals.join('_').trim()
    if (!migration) {
      throw new KitError('kit db create takes a migration name', 'kit db create add_widgets', ExitCode.usage)
    }
    await runD1(ctx, { kind: 'create', migration }, { mutates: true })
  },
})
