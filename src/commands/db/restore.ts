import { defineCommand } from '../../cli/command'
import { dbArgs, remoteArg } from '../../lib/cloudflare'

export default defineCommand({
  description: 'Run a .sql backup against a D1 database (local by default)',
  group: 'Infra',
  args: { ...dbArgs, ...remoteArg },
  examples: [
    'kit db restore backups/my-db-20260102T030405Z.sql',
    'kit db restore prod.sql --remote     # asks first; --yes skips',
  ].join('\n'),
  async run(ctx) {
    const { existsSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { runD1 } = await import('../../lib/cloudflare')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const [name, ...more] = ctx.positionals
    if (!name || more.length) {
      throw new KitError(
        'kit db restore takes one .sql file',
        'kit db restore backups/<file>.sql',
        ExitCode.usage,
      )
    }
    // wrangler runs from the target dir; keep the file relative to where kit was started.
    const file = resolve(process.cwd(), name)
    if (!existsSync(file)) throw new KitError(`No file ${name}`, undefined, ExitCode.usage)
    await runD1(ctx, { kind: 'exec', remote: !!ctx.args.remote, file }, { mutates: true })
  },
})
