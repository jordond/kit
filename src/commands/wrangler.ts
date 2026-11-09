import { defineCommand } from '../cli/command'

const DESCRIPTION = "Run wrangler in a worker target's directory (arguments pass through)"
const EXAMPLES = 'kit wrangler api whoami\nkit wrangler api d1 list\nkit wrangler api deploy --dry-run'

/** `kit wrangler --help`: arguments pass through, so kit's own help never sees a leading flag. */
export function wranglerUsage(workers: string[] | undefined): string {
  const lines = [DESCRIPTION, '', 'Usage: kit wrangler <worker target> [wrangler args…]', '', 'Examples:']
  for (const e of EXAMPLES.split('\n')) lines.push(`  ${e}`)
  if (workers) {
    lines.push('', workers.length ? `Worker targets: ${workers.join(', ')}` : 'No target has kind "worker"')
  }
  return `${lines.join('\n')}\n`
}

export default defineCommand({
  description: DESCRIPTION,
  group: 'Develop',
  passthrough: true,
  examples: EXAMPLES,
  async run(ctx) {
    const workersOf = (targets: Record<string, { kind: string }>) =>
      Object.entries(targets)
        .filter(([, t]) => t.kind === 'worker')
        .map(([n]) => n)
    const first = ctx.rest[0]
    if (first === '-h' || first === '--help') {
      process.stdout.write(wranglerUsage(ctx.config ? workersOf(ctx.config.targets) : undefined))
      return
    }
    const { join } = await import('node:path')
    const { requireProject } = await import('../cli/command')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { detectPackageManager, pmExec } = await import('../lib/pm')
    const { run } = await import('../lib/proc')
    const { root, config } = requireProject(ctx)
    const workers = workersOf(config.targets)
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
