import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Render the store screenshots from the raw shots and the saved project',
  group: 'Quality',
  examples:
    'kit shots export\nkit shots export --store apple --locale en-US\nkit shots export --out build/store-shots --dry-run --json',
  args: {
    store: { type: 'string', description: 'apple, google or both (default both)' },
    locale: { type: 'string', description: 'Only these locales, comma-separated (en-US,fr-FR)' },
    out: {
      type: 'string',
      description: 'Write under <dir>/apple and <dir>/google instead of the store listing dirs',
    },
    'allow-missing': { type: 'boolean', description: 'Skip slides whose raw shot is absent' },
    force: { type: 'boolean', description: 'Replace images in a set that kit did not write' },
  },
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { exportShots } = await import('../../lib/storeshots/command')
    const { parseStores } = await import('../../lib/storeshots/sizes')
    requireProject(ctx)
    const locales = ctx.args.locale
      ?.split(',')
      .map((l) => l.trim())
      .filter(Boolean)
    if (ctx.args.locale !== undefined && !locales?.length) {
      const { ExitCode, KitError } = await import('../../lib/errors')
      throw new KitError('--locale names no locale', 'e.g. --locale en-US,fr-FR', ExitCode.usage)
    }
    await exportShots(ctx, {
      stores: parseStores(ctx.args.store),
      locales,
      out: ctx.args.out,
      allowMissing: ctx.args['allow-missing'] === true,
      force: ctx.args.force === true,
    })
  },
})
