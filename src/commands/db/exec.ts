import { defineCommand } from '../../cli/command'
import { dbArgs, remoteArg } from '../../lib/cloudflare'

export default defineCommand({
  description: 'Run SQL against a D1 database (local by default)',
  group: 'Infra',
  args: {
    ...dbArgs,
    ...remoteArg,
    file: { type: 'string', short: 'f', description: 'Run a .sql file instead of a statement' },
  },
  examples: [
    'kit db exec "SELECT count(*) FROM users"',
    'kit db exec --remote "SELECT 1" --json',
    'kit db exec --file seed.sql',
  ].join('\n'),
  async run(ctx) {
    const { runD1 } = await import('../../lib/cloudflare')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { resolve } = await import('node:path')
    const sql = ctx.positionals.join(' ').trim()
    const file = ctx.args.file
    if (!sql === !file) {
      throw new KitError(
        'kit db exec takes a SQL statement or --file, not both',
        'kit db exec "SELECT 1"  or  kit db exec --file seed.sql',
        ExitCode.usage,
      )
    }
    await runD1(
      ctx,
      {
        kind: 'exec',
        remote: !!ctx.args.remote,
        // wrangler runs from the target dir; keep the file relative to where kit was started.
        ...(file ? { file: resolve(process.cwd(), file) } : { sql }),
      },
      { mutates: true },
    )
  },
})
