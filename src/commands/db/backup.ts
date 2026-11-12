import { defineCommand } from '../../cli/command'
import { dbArgs, remoteArg } from '../../lib/cloudflare'

export default defineCommand({
  description: 'Export a D1 database to a .sql file (local by default)',
  group: 'Infra',
  args: {
    ...dbArgs,
    ...remoteArg,
    out: {
      type: 'string',
      short: 'o',
      description: 'File to write (default: backups/<db>-<UTC timestamp>.sql)',
    },
  },
  examples: [
    'kit db backup                       # backups/<db>-20260102T030405Z.sql',
    'kit db backup --remote --db analytics',
    'kit db backup --remote --out prod.sql',
  ].join('\n'),
  async run(ctx) {
    const { mkdirSync } = await import('node:fs')
    const { dirname, relative, resolve } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { backupFile, resolveD1, runD1 } = await import('../../lib/cloudflare')
    const { root, config } = requireProject(ctx)
    const db = resolveD1(config, ctx.args.db)
    // wrangler runs from the target dir; --out stays relative to where kit was started.
    const file = ctx.args.out ? resolve(process.cwd(), ctx.args.out) : backupFile(root, db)
    const shown = relative(process.cwd(), file)
    if (!ctx.flags.dryRun) mkdirSync(dirname(file), { recursive: true })
    // Writes a file (so --dry-run skips it) but changes nothing remote: no confirmation.
    const outcome = await runD1(
      ctx,
      { kind: 'export', remote: !!ctx.args.remote, output: file },
      { mutates: true, confirm: false, json: { file: shown } },
    )
    if (outcome !== 'ok') return
    if (!ctx.flags.json) process.stdout.write(`${shown}\n`)
    // A dump (a production one with --remote) must not be committed by accident. Exit 1 = not
    // ignored; anything else (not a git repo, no git) is nothing to warn about.
    const { runPiped } = await import('../../lib/proc')
    const ignored = await runPiped(['git', 'check-ignore', '-q', file], { cwd: root }).catch(() => undefined)
    if (ignored?.code === 1) {
      ctx.log.warn(`${shown} is not ignored by git; add \`backups/\` to .gitignore before committing`)
    }
  },
})
