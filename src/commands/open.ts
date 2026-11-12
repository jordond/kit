import { defineCommand } from '../cli/command'

export default defineCommand({
  description: "Open a worker target's Cloudflare dashboard page",
  group: 'Develop',
  args: {
    env: { type: 'string', short: 'e', description: 'Environment, for targets that declare envs' },
    print: { type: 'boolean', short: 'p', description: 'Write the URL to stdout instead of opening it' },
  },
  examples: [
    'kit open api',
    'kit open api --env staging',
    'kit open api --print',
    'kit open api --json',
  ].join('\n'),
  async run(ctx) {
    const { relative, resolve } = await import('node:path')
    const { requireProject } = await import('../cli/command')
    const { readAccountId, resolveAccountId } = await import('../lib/cloudflare')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { emitJson } = await import('../lib/log')
    const { runQuiet } = await import('../lib/proc')
    const { dashboardUrl, readWranglerConfig, requireWorker, workerName } = await import('../lib/worker')
    const { checkEnv } = await import('./deploy')
    const { root, config } = requireProject(ctx)
    const [name, ...more] = ctx.positionals
    const target = requireWorker(config, name, 'kit open')
    if (more.length) throw new KitError('kit open takes one worker target', undefined, ExitCode.usage)
    const env = checkEnv(config, name!, ctx.args.env)
    const dir = resolve(root, target.dir)
    const wranglerConfig = readWranglerConfig(dir)
    const worker = wranglerConfig && workerName(wranglerConfig.data, env)
    if (!worker) {
      const where = wranglerConfig ? relative(root, wranglerConfig.file) : `${target.dir}/wrangler.jsonc`
      throw new KitError(`No worker name in ${where}`, `Add "name" to ${where}`, ExitCode.config)
    }
    // cloudflare.accountId when set; else this worker's own account_id; else the dashboard asks.
    const url = dashboardUrl(resolveAccountId(root, config) ?? readAccountId(dir).id, worker)
    if (ctx.flags.json) {
      emitJson({ target: name, env, worker, url })
      return
    }
    if (ctx.args.print) {
      process.stdout.write(`${url}\n`)
      return
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    if (ctx.flags.dryRun) {
      ctx.log.step(`${opener} ${url}`)
      return
    }
    // A missing opener (a headless box) fails the same way as one that exits non-zero.
    const { code, output } = await runQuiet([opener, url]).catch(() => ({ code: 127, output: '' }))
    if (code !== 0) {
      throw new KitError(
        `${opener} failed (exit ${code})${output.trim() ? `: ${output.trim()}` : ''}`,
        `Open it yourself: ${url}`,
      )
    }
    ctx.log.success(`opened ${url}`)
  },
})
