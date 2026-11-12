import { defineCommand } from '../cli/command'

export default defineCommand({
  description: "Tail a deployed worker's logs (wrangler tail; Ctrl-C stops)",
  group: 'Infra',
  args: {
    env: { type: 'string', short: 'e', description: 'Environment, for targets that declare envs' },
  },
  examples: [
    'kit logs api',
    'kit logs api --env staging',
    'kit logs api -- --status error --format json   # after --: wrangler tail flags',
  ].join('\n'),
  async run(ctx) {
    const { relative } = await import('node:path')
    const { requireProject } = await import('../cli/command')
    const { pinCloudflareAccount, wrangler } = await import('../lib/cloudflare')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { emitJson } = await import('../lib/log')
    const { runInteractive } = await import('../lib/proc')
    const { requireWorker, tailArgs } = await import('../lib/worker')
    const { checkEnv } = await import('./deploy')
    const { root, config } = requireProject(ctx)
    const [name, ...more] = ctx.positionals
    requireWorker(config, name, 'kit logs')
    if (more.length) {
      throw new KitError(
        'kit logs takes one worker target',
        'wrangler tail flags go after --',
        ExitCode.usage,
      )
    }
    const env = checkEnv(config, name!, ctx.args.env)
    const w = wrangler(root, config, name!, ...tailArgs({ env, extra: ctx.rest }))
    const cwd = relative(root, w.cwd) || '.'
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ dryRun: true, target: name, env, cmd: w.cmd, cwd })
      else ctx.log.step(`${cwd} $ ${w.cmd.join(' ')}`)
      return
    }
    if (config.cloudflare?.accountId) pinCloudflareAccount(root, config)
    // Attached to the terminal; the log lines are the result, so they stay on stdout. A Ctrl-C is the
    // way out of a tail: wrangler closes the session and kit exits 130.
    const code = await runInteractive(w.cmd, { cwd: w.cwd })
    if (code !== 0) process.exitCode = ExitCode.failed
  },
})
