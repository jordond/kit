import { defineCommand } from '../cli/command'

export default defineCommand({
  description: "Run wrangler in a worker target's directory (arguments pass through)",
  group: 'Develop',
  passthrough: true,
  examples: 'kit wrangler api whoami\nkit wrangler api d1 list\nkit wrangler api deploy --dry-run',
  async run(ctx) {
    const { join } = await import('node:path')
    const { requireProject } = await import('../cli/command')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { detectPackageManager, pmExec } = await import('../lib/pm')
    const { run } = await import('../lib/proc')
    const { root, config } = requireProject(ctx)
    const workers = Object.entries(config.targets)
      .filter(([, t]) => t.kind === 'worker')
      .map(([n]) => n)
    const hint = workers.length ? `Worker targets: ${workers.join(', ')}` : 'No target has kind "worker"'
    const [name, ...args] = ctx.rest
    if (!name || name.startsWith('-')) {
      throw new KitError('kit wrangler takes a worker target first', hint, ExitCode.usage)
    }
    const target = config.targets[name]
    if (target?.kind !== 'worker') {
      throw new KitError(`"${name}" is not a worker target`, hint, ExitCode.usage)
    }
    if (config.cloudflare?.accountId) (await import('../lib/cloudflare')).pinCloudflareAccount(root, config)
    const dir = join(root, target.dir)
    process.exitCode = await run(pmExec(detectPackageManager(dir, root), 'wrangler', ...args), { cwd: dir })
  },
})
