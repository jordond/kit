import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Rewrite the saved shots project as a version 2 project (rules once, sparse slides)',
  group: 'Quality',
  examples: 'kit shots migrate\nkit shots migrate --write\nkit shots migrate --write --dry-run --json',
  args: {
    write: {
      type: 'boolean',
      description: 'Replace shots.project with the version 2 file (default: print it)',
    },
  },
  async run(ctx) {
    const { migrateShots } = await import('../../lib/storeshots/migrate-command')
    await migrateShots(ctx, { write: ctx.args.write === true })
  },
})
