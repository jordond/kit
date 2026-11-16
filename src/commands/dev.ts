import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Run dev servers: one target, several, or every target with a dev command (Ctrl-C stops all)',
  group: 'Develop',
  args: {
    env: { type: 'string', short: 'e', description: 'Environment, for targets that declare envs' },
  },
  examples: [
    'kit dev                  # workspace.dev and every target with a dev command, together',
    'kit dev api              # one dev server, attached to the terminal',
    'kit dev api admin        # several, output prefixed by target',
    'kit dev web --env staging',
    'kit dev --dry-run --json',
  ].join('\n'),
  async run(ctx) {
    const { relative } = await import('node:path')
    const { requireProject } = await import('../cli/command')
    const { installGroup, selectTargets, targetCommands, WORKSPACE } = await import('../lib/targets')
    const { envsFor } = await import('./deploy')
    const { run, runInteractive, runToStderr, shell } = await import('../lib/proc')
    const { interrupted } = await import('../lib/cleanup')
    const { emitJson } = await import('../lib/log')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { root, config } = requireProject(ctx)
    if (config.cloudflare?.accountId) {
      try {
        ;(await import('../lib/cloudflare')).pinCloudflareAccount(root, config)
      } catch (e) {
        if (!(e instanceof KitError)) throw e
        ctx.log.warn(`${e.message}; CLOUDFLARE_ACCOUNT_ID not pinned`)
      }
    }

    const named = ctx.positionals
    const bare = !named.length
    // Validates names (with a suggestion); `workspace` alone selects no target.
    const names = selectTargets(config, named).targets.map(([n]) => n)
    const envs = envsFor(config, names, ctx.args.env)
    const lanes: { name: string; commands: import('../lib/targets').PlannedCommand[] }[] = []
    if (bare || named.includes(WORKSPACE)) {
      const ws = config.workspace?.dev
      if (ws) {
        const list = Array.isArray(ws) ? ws : [ws]
        lanes.push({
          name: WORKSPACE,
          commands: list.map((s) => ({ title: s, cmd: shell(s, ctx.rest), cwd: root })),
        })
      }
    }
    for (const name of names) {
      const cmds = targetCommands(root, config, name, 'dev', { env: envs.get(name), extra: ctx.rest })
      if (cmds) lanes.push({ name, commands: cmds })
      else if (!bare) {
        throw new KitError(
          `Target "${name}" has no dev command`,
          `Set targets.${name}.dev in kit.config.ts`,
          ExitCode.usage,
        )
      }
    }
    if (!lanes.length) {
      throw new KitError(
        'No target has a dev command',
        'Set workspace.dev or targets.<name>.dev in kit.config.ts',
        ExitCode.usage,
      )
    }

    // A fresh clone: install what the servers need before any of them starts.
    const install = installGroup(
      root,
      config,
      lanes.map((l) => l.name),
      lanes.some((l) => l.name === WORKSPACE),
    )
    const planned = install ? [{ name: install.title, commands: install.commands }, ...lanes] : lanes

    const where = (cwd: string) => relative(root, cwd) || '.'
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) {
        emitJson({
          dryRun: true,
          plan: planned.map((l) => ({
            target: l.name,
            commands: l.commands.map((c) => ({ cmd: c.cmd, cwd: where(c.cwd) })),
          })),
        })
      } else {
        for (const l of planned)
          for (const c of l.commands) ctx.log.step(`${l.name}  ${where(c.cwd)} $ ${c.cmd.join(' ')}`)
      }
      return
    }

    for (const c of install?.commands ?? []) {
      ctx.log.step(c.title)
      const code = await (ctx.flags.json ? runToStderr : run)(c.cmd, { cwd: c.cwd })
      if (code !== 0) throw new KitError(`${c.title} failed (exit ${code})`, undefined, ExitCode.precondition)
    }

    let results: { name: string; code: number }[]
    if (lanes.length === 1 && !ctx.flags.json) {
      // One server: attach it to the terminal (stdin works, no prefixes).
      const lane = lanes[0]!
      let code = 0
      for (const c of lane.commands) {
        code = await runInteractive(c.cmd, { cwd: c.cwd, env: c.env })
        if (interrupted() || code !== 0) break
      }
      results = [{ name: lane.name, code }]
    } else {
      const { runConcurrent } = await import('../lib/concurrent')
      if (!ctx.flags.json) ctx.log.step(`dev: ${lanes.map((l) => l.name).join(', ')}  (Ctrl-C stops all)`)
      // --json: server output goes to stderr; the one document comes last.
      results = await runConcurrent(lanes, ctx.flags.json ? { write: (s) => process.stderr.write(s) } : {})
    }
    const ok = results.every((r) => r.code === 0)
    if (ctx.flags.json) emitJson({ ok, interrupted: interrupted(), targets: results })
    if (!ok) process.exitCode = ExitCode.failed
  },
})
