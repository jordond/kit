import { defineCommand } from '../../cli/command'

/** The flags that take a value: an empty one is a mistake (an unset variable), never the default. */
const VALUE_FLAGS = {
  store: 'e.g. --store apple',
  locale: 'e.g. --locale en-US,fr-FR',
  out: 'e.g. --out build/store-shots',
} as const

/**
 * The value flags passed with an empty value (`--out ""`, `--out=`), read from the command line:
 * the parser drops an empty value, so `ctx.args` cannot tell `--out ""` from no `--out` at all.
 */
export function emptyValueFlags(argv: readonly string[]): string[] {
  const end = argv.indexOf('--')
  const tokens = end < 0 ? argv : argv.slice(0, end)
  return Object.keys(VALUE_FLAGS).filter((name) =>
    tokens.some((token, i) => token === `--${name}=` || (token === `--${name}` && tokens[i + 1] === '')),
  )
}

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
    const { ExitCode, KitError } = await import('../../lib/errors')
    const [empty] = emptyValueFlags(process.argv.slice(2))
    if (empty !== undefined) {
      throw new KitError(
        `--${empty} has an empty value`,
        VALUE_FLAGS[empty as keyof typeof VALUE_FLAGS],
        ExitCode.usage,
      )
    }
    requireProject(ctx)
    const locales = ctx.args.locale
      ?.split(',')
      .map((l) => l.trim())
      .filter(Boolean)
    if (ctx.args.locale !== undefined && !locales?.length) {
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
