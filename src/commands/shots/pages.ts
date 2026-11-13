import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Render the HTML artwork pages in shots.pages to PNGs, without alpha',
  group: 'Quality',
  examples: 'kit shots pages\nkit shots pages header search\nkit shots pages --out build/artwork --json',
  args: {
    out: { type: 'string', description: "Write the PNGs into <dir> instead of each page's own path" },
  },
  async run(ctx) {
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { emptyValueFlags } = await import('./export')
    const { runPages } = await import('../../lib/storeshots/pages-command')
    if (emptyValueFlags(process.argv.slice(2)).includes('out')) {
      throw new KitError('--out has an empty value', 'e.g. --out build/artwork', ExitCode.usage)
    }
    await runPages(ctx, { names: ctx.positionals, out: ctx.args.out })
  },
})
