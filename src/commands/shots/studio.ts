import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Edit the shots project in a browser: slides, styles, a live preview, export',
  group: 'Quality',
  examples: 'kit shots studio\nkit shots studio --port 4173 --no-open',
  args: {
    port: { type: 'string', description: 'Listen on this port (default: one the OS picks)' },
    open: {
      type: 'boolean',
      negatable: true,
      default: true,
      description: 'Open the browser (--no-open: do not)',
    },
  },
  async run(ctx) {
    const { studioShots } = await import('../../lib/storeshots/studio')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const raw = ctx.args.port
    const port = raw === undefined ? undefined : Number(raw)
    if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
      throw new KitError(`--port ${raw} is not a port`, 'e.g. --port 4173', ExitCode.usage)
    }
    await studioShots(ctx, { port, open: ctx.args.open !== false })
  },
})
