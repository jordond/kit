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
    const { existsSync, rmSync } = await import('node:fs')
    const { relative, resolve } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { d1Args, pinCloudflareAccount, resolveD1, seedFile, wrangler } = await import(
      '../../lib/cloudflare'
    )
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { emitJson } = await import('../../lib/log')
    const { run, runToStderr } = await import('../../lib/proc')
    const { confirm } = await import('../../lib/prompt')
    const { localD1Files, localD1Id, localD1Ids, localD1Sqlite, localD1StateDir, readWranglerConfig } =
      await import('../../lib/worker')
    if (ctx.args.remote) {
      throw new KitError(
        'kit db reset is local only',
        'For a deployed database: kit db backup --remote, then kit db exec --remote',
        ExitCode.usage,
      )
    }
    const { root, config } = requireProject(ctx)
    const db = resolveD1(config, ctx.args.db)
    const dir = resolve(root, config.targets[db.target]!.dir)
    const rel = (p: string) => relative(root, p) || '.'
    const wranglerConfig = readWranglerConfig(dir)
    const id = wranglerConfig && localD1Id(wranglerConfig.data, db.name)
    if (!id) {
      const where = wranglerConfig ? rel(wranglerConfig.file) : `${rel(dir)}/wrangler.jsonc`
      throw new KitError(
        `No d1_databases entry for ${db.name} in ${where}`,
        'kit finds the local database file through its database_id or binding',
        ExitCode.config,
      )
    }
    const files = localD1Files(dir, id).filter((f) => existsSync(f))
    // Databases exist locally but none is where kit expects any of this worker's: wrangler's layout
    // has changed, and migrating now would report a reset that deleted nothing. A file of another
    // database the worker binds proves the layout, so this one is just fresh, as with no sqlite at all.
    // Every cloudflare.d1 entry of this target resolves through the same d1_databases list.
    const known = new Set(localD1Ids(wranglerConfig.data).map((k) => localD1Files(dir, k)[0]!))
    const present = localD1Sqlite(dir)
    if (present.length && !present.some((f) => known.has(f))) {
      const state = rel(localD1StateDir(dir))
      throw new KitError(
        `Local D1 layout not recognised: ${state} holds databases, none of them one this worker binds`,
        `Nothing was deleted or migrated. Run \`kit clean --deep\` or remove ${rel(dir)}/.wrangler/state by hand`,
      )
    }
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
    for (const f of files) rmSync(f, { force: true })
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
