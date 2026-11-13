import { defineCommand } from '../../cli/command'
import { dbArgs } from '../../lib/cloudflare'

export default defineCommand({
  description: 'Local only: delete a local D1 database, re-apply migrations, then seed if configured',
  group: 'Infra',
  args: {
    ...dbArgs,
    remote: { type: 'boolean', description: 'Rejected: a deployed database is never reset' },
  },
  examples: 'kit db reset\nkit db reset --db analytics --yes\nkit db reset --dry-run',
  async run(ctx) {
    const { relative } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { d1Args, pinCloudflareAccount, resolveD1, seedFile, wrangler } =
      await import('../../lib/cloudflare')
    const { locateLocalD1, removeLocalD1, requireLocalD1 } = await import('../../lib/d1-local')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { emitJson } = await import('../../lib/log')
    const { run, runToStderr } = await import('../../lib/proc')
    const { confirm } = await import('../../lib/prompt')
    if (ctx.args.remote) {
      throw new KitError(
        'kit db reset is local only',
        'For a deployed database: kit db backup --remote, then kit db exec --remote',
        ExitCode.usage,
      )
    }
    const { root, config } = requireProject(ctx)
    const db = resolveD1(config, ctx.args.db)
    const rel = (p: string) => relative(root, p) || '.'
    // Stops here when wrangler's local state is not laid out the way kit knows.
    const local = locateLocalD1(root, config, db)
    const files = local.files
    // Resolved before anything is deleted: a missing seed file must not leave an empty database.
    const seed = db.seed ? seedFile(root, db) : undefined
    const steps = [
      {
        title: 'migrate',
        w: wrangler(root, config, db.target, ...d1Args(db, { kind: 'migrate', remote: false })),
      },
      ...(seed
        ? [
            {
              title: 'seed',
              w: wrangler(
                root,
                config,
                db.target,
                ...d1Args(db, { kind: 'exec', remote: false, file: seed }),
              ),
            },
          ]
        : []),
    ]
    const shown = (s: (typeof steps)[number]) => `${rel(s.w.cwd)} $ ${s.w.cmd.join(' ')}`

    if (ctx.flags.dryRun) {
      if (ctx.flags.json) {
        emitJson({
          dryRun: true,
          db: db.name,
          remove: files.map(rel),
          plan: steps.map((s) => ({ title: s.title, cmd: s.w.cmd, cwd: rel(s.w.cwd) })),
        })
      } else {
        for (const f of files) ctx.log.step(`rm ${rel(f)}`)
        for (const s of steps) ctx.log.step(shown(s))
      }
      return
    }
    if (!(await confirm(ctx.flags, `Reset local ${db.name}? Its local data is deleted`))) {
      throw new KitError('Cancelled', undefined, ExitCode.interrupted)
    }
    pinCloudflareAccount(root, config)
    removeLocalD1(local)
    if (!ctx.flags.json)
      ctx.log.step(files.length ? `removed local ${db.name}` : `no local ${db.name} to remove`)

    // --json: children print to stderr and the one document comes last.
    const exec = ctx.flags.json ? runToStderr : run
    const results: { title: string; code: number }[] = []
    for (const s of steps) {
      if (!ctx.flags.json) ctx.log.dim(shown(s))
      const code = await exec(s.w.cmd, { cwd: s.w.cwd })
      results.push({ title: s.title, code })
      if (code !== 0) break
      // The migrated database must be where kit just deleted from; otherwise nothing was reset.
      if (s.title === 'migrate') requireLocalD1(root, db, local)
    }
    const ok = results.every((r) => r.code === 0)
    if (ctx.flags.json) emitJson({ db: db.name, ok, removed: files.map(rel), steps: results })
    if (!ok) {
      if (!ctx.flags.json) ctx.log.error(`reset ${db.name}: ${results.at(-1)!.title} failed`)
      process.exitCode = ExitCode.failed
      return
    }
    ctx.log.success(`reset local ${db.name}${seed ? ' (seeded)' : ''}`)
  },
})
