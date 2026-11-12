import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Roll a worker service back to an earlier version (wrangler rollback); tags stay put',
  group: 'Release',
  args: {
    to: {
      type: 'string',
      description: 'Version id to roll back to (default: the version before the latest)',
    },
  },
  examples: [
    'kit release rollback api',
    'kit release rollback api --to 3f1c2d4e-0000-4000-8000-000000000000',
    'kit release rollback api --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { relative } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { pinCloudflareAccount, wrangler } = await import('../../lib/cloudflare')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { describe } = await import('../../lib/git')
    const { emitJson } = await import('../../lib/log')
    const { run, runToStderr } = await import('../../lib/proc')
    const { confirm } = await import('../../lib/prompt')
    const { rollbackArgs, serviceDeployTarget } = await import('../../lib/worker')
    const { root, config } = requireProject(ctx)
    const services = config.release?.services ?? {}
    const [name, ...more] = ctx.positionals
    const known = Object.keys(services)
    const svc = name ? services[name] : undefined
    if (!name || !svc || more.length) {
      throw new KitError(
        !name || more.length ? 'kit release rollback takes one service' : `Unknown service "${name}"`,
        known.length ? `Services: ${known.join(', ')}` : 'Add release.services in kit.config.ts',
        ExitCode.usage,
      )
    }
    const deployed = serviceDeployTarget(svc.deploy)
    const target = deployed ? config.targets[deployed.target] : undefined
    if (!deployed || target?.kind !== 'worker') {
      const why = !deployed
        ? `release.services.${name}.deploy is not \`kit deploy <worker target>\``
        : target
          ? `${name} deploys "${deployed.target}", a ${target.kind} target`
          : `${name} deploys "${deployed.target}", which is not a target`
      throw new KitError(
        `Cannot roll back ${name}: rollback is worker-only`,
        `${why}. Redeploy an earlier commit instead`,
        ExitCode.usage,
      )
    }
    const to = ctx.args.to
    const w = wrangler(
      root,
      config,
      deployed.target,
      ...rollbackArgs({ to, env: deployed.env, message: `kit release rollback ${name}` }),
    )
    const cwd = relative(root, w.cwd) || '.'
    // The newest release tag still names the version being rolled away from. kit leaves tags alone.
    const staleTag = await describe(`${name}/v*`, { cwd: root }).catch(() => undefined)
    const base = { service: name, target: deployed.target, env: deployed.env, to: to ?? 'previous' }

    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ dryRun: true, ...base, cmd: w.cmd, cwd, staleTag })
      else ctx.log.step(`${cwd} $ ${w.cmd.join(' ')}`)
      return
    }
    const where = `${deployed.target}${deployed.env ? ` (${deployed.env})` : ''}`
    const goal = to ? `version ${to}` : 'the previous version'
    if (!(await confirm(ctx.flags, `Roll ${name} (worker ${where}) back to ${goal}?`))) {
      throw new KitError('Cancelled', undefined, ExitCode.interrupted)
    }
    if (config.cloudflare?.accountId) pinCloudflareAccount(root, config)
    if (!ctx.flags.json) ctx.log.dim(`${cwd} $ ${w.cmd.join(' ')}`)
    // --json: wrangler prints to stderr and the one document comes last.
    const code = await (ctx.flags.json ? runToStderr : run)(w.cmd, { cwd: w.cwd })
    const ok = code === 0
    if (ctx.flags.json) emitJson({ ...base, ok, ...(ok ? { staleTag } : {}) })
    if (!ok) {
      if (!ctx.flags.json) ctx.log.error(`rollback ${name} failed (exit ${code})`)
      process.exitCode = ExitCode.failed
      return
    }
    ctx.log.success(`rolled ${name} back to ${goal}`)
    ctx.log.warn(
      staleTag
        ? `tag ${staleTag} no longer matches production; kit did not move or delete it`
        : `no ${name}/v* tag found; git tags were not touched`,
    )
  },
})
