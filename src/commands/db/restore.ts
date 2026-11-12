import { defineCommand } from '../../cli/command'
import { dbArgs, remoteArg } from '../../lib/cloudflare'

export default defineCommand({
  description: 'Restore a D1 database from a .sql backup (local: replaces it; remote: must be empty)',
  group: 'Infra',
  args: { ...dbArgs, ...remoteArg },
  examples: [
    'kit db restore backups/my-db-20260102T030405Z.sql   # deletes the local database first',
    'kit db restore prod.sql --remote                    # only into an empty database; asks first',
  ].join('\n'),
  async run(ctx) {
    const { accessSync, constants, existsSync } = await import('node:fs')
    const { relative, resolve } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { d1Args, d1Tables, pinCloudflareAccount, resolveD1, runD1, TABLES_SQL, wrangler } = await import(
      '../../lib/cloudflare'
    )
    const { locateLocalD1, removeLocalD1, requireLocalD1 } = await import('../../lib/d1-local')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { emitJson } = await import('../../lib/log')
    const { run, runPiped } = await import('../../lib/proc')
    const { confirm } = await import('../../lib/prompt')
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
    try {
      accessSync(file, constants.R_OK)
    } catch {
      throw new KitError(`Cannot read ${name}`, undefined, ExitCode.usage)
    }
    const { root, config } = requireProject(ctx)
    const db = resolveD1(config, ctx.args.db)
    const remote = !!ctx.args.remote
    const action = { kind: 'exec', remote, file } as const

    // A backup carries the schema and the d1_migrations rows, so it only loads into an empty database.
    if (remote) {
      // Remote tables are never dropped: a database that already has some is the user's call.
      if (!ctx.flags.dryRun) {
        pinCloudflareAccount(root, config)
        const w = wrangler(
          root,
          config,
          db.target,
          ...d1Args(db, { kind: 'exec', remote: true, sql: TABLES_SQL, json: true }),
        )
        const listed = await runPiped(w.cmd, { cwd: w.cwd })
        const tables = listed.code === 0 ? d1Tables(listed.stdout) : undefined
        if (!tables) {
          throw new KitError(
            `Could not check that remote ${db.name} is empty`,
            (listed.stderr || listed.stdout).trim().split('\n').at(-1) || undefined,
            ExitCode.precondition,
          )
        }
        if (tables.length) {
          throw new KitError(
            `Remote ${db.name} is not empty: ${tables.join(', ')}`,
            'A backup restores into an empty database only; kit never drops remote tables. Create a new database, or drop these yourself',
            ExitCode.precondition,
          )
        }
      }
      await runD1(ctx, action, { mutates: true })
      return
    }

    // Local: the database is replaced, the way `kit db reset` deletes it (and with the same guards).
    // Every check comes before the delete: a restore that cannot run must leave the old data alone.
    const local = locateLocalD1(root, config, db)
    const rel = (p: string) => relative(root, p) || '.'
    const w = wrangler(root, config, db.target, ...d1Args(db, { ...action, json: ctx.flags.json }))
    const shown = `${rel(w.cwd)} $ ${w.cmd.join(' ')}`
    const removed = local.files.map(rel)
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) {
        emitJson({ dryRun: true, db: db.name, remote: false, remove: removed, cmd: w.cmd, cwd: rel(w.cwd) })
      } else {
        for (const f of removed) ctx.log.step(`rm ${f}`)
        ctx.log.step(shown)
      }
      return
    }
    pinCloudflareAccount(root, config)
    if (!(await confirm(ctx.flags, `Replace local ${db.name} with ${name}? Its local data is deleted`))) {
      throw new KitError('Cancelled', undefined, ExitCode.interrupted)
    }
    removeLocalD1(local)
    if (!ctx.flags.json) {
      ctx.log.step(removed.length ? `removed local ${db.name}` : `no local ${db.name} to remove`)
      ctx.log.dim(shown)
    }
    // --json: wrangler's result is held back until the database is known to be where kit deleted
    // from, so one document says what happened.
    let result: unknown
    let code: number
    if (ctx.flags.json) {
      const done = await runPiped(w.cmd, { cwd: w.cwd })
      code = done.code
      if (done.stderr) process.stderr.write(done.stderr)
      try {
        result = JSON.parse(done.stdout)
      } catch {
        result = done.stdout
      }
    } else {
      code = await run(w.cmd, { cwd: w.cwd })
    }
    if (code === 0) requireLocalD1(root, db, local)
    if (ctx.flags.json) emitJson({ db: db.name, remote: false, ok: code === 0, removed, result })
    if (code !== 0) process.exitCode = ExitCode.failed
  },
})
