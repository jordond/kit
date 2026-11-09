import type { CommandContext } from 'gunshi'
import { plugin } from 'gunshi/plugin'
import { ExitCode, KitError } from '../lib/errors'

/**
 * Replaces gunshi's built-in global plugin, which hard-codes `-v` for --version.
 * kit uses `-V, --version` and keeps `-v` for --verbose (clig.dev convention).
 */
export const SHOW_USAGE = Symbol('kit.showUsage')

export function kitGlobals(version: string, renderUsage: (ctx: Readonly<CommandContext>) => Promise<string>) {
  return plugin({
    id: 'kit:globals',
    name: 'kit global options',
    setup(ctx) {
      ctx.addGlobalOption('help', { type: 'boolean', short: 'h', description: 'Show help' })
      ctx.addGlobalOption('version', { type: 'boolean', short: 'V', description: 'Show kit version' })
      ctx.decorateCommand((run) => async (c) => {
        if (c.values.version) {
          process.stdout.write(`${version}\n`)
          return
        }
        if (c.values.help || c.callMode === 'entry') {
          process.stdout.write(`${await renderUsage(c)}\n`)
          return
        }
        if (c.validationError) {
          const msgs = c.validationError.errors.map((e: Error) => e.message).join('\n  ')
          throw new KitError(msgs, `Run \`kit ${c.commandPath.join(' ')} --help\``, ExitCode.usage)
        }
        try {
          return await run(c)
        } catch (e) {
          if (e !== SHOW_USAGE) throw e
          process.stdout.write(`${await renderUsage(c)}\n`)
        }
      })
    },
  })
}
