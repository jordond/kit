import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Run a dev server (Ctrl-C to stop)',
  group: 'Develop',
  args: {
    env: { type: 'string', short: 'e', description: 'Environment (when the target has envs)' },
  },
  examples: 'kit dev api\nkit dev web --env staging',
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { singleTarget } = await import('./_verb')
    const { targetCommands } = await import('../lib/targets')
    const { checkEnv } = await import('./deploy')
    const { runInteractive } = await import('../lib/proc')
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
    const name = singleTarget(ctx, 'dev')
    const env = checkEnv(config, name, ctx.args.env)
    const cmds = targetCommands(root, config, name, 'dev', { env, extra: ctx.rest })
    if (!cmds) {
      throw new KitError(
        `Target "${name}" has no dev command`,
        `Set targets.${name}.dev in kit.config.ts`,
        ExitCode.usage,
      )
    }
    if (ctx.flags.dryRun) {
      for (const c of cmds) ctx.log.step(`${c.cmd.join(' ')}  ${c.cwd}`)
      return
    }
    for (const c of cmds) {
      const code = await runInteractive(c.cmd, { cwd: c.cwd, env: c.env })
      if ((await import('../lib/cleanup')).interrupted()) return
      if (code !== 0) {
        process.exitCode = 1
        return
      }
    }
  },
})
