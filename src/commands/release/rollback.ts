import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Roll a worker service back to an earlier version (wrangler rollback); tags stay put',
  group: 'Release',
  args: {
    to: {
      type: 'string',
      description: 'Version id to roll back to (default: the last deployment with different code)',
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
    const { runLines, runPiped } = await import('../../lib/proc')
    const { confirm } = await import('../../lib/prompt')
    const { gradualRollout, listArgs, pickRollback, rollbackArgs, serviceDeployTarget } = await import(
      '../../lib/worker'
    )
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
    const cwdOf = (dir: string) => relative(root, dir) || '.'
    const message = `kit release rollback ${name}`
    const plan = (to: string) =>
      wrangler(root, config, deployed.target, ...rollbackArgs({ to, env: deployed.env, message }))
    // The newest release tag still names the version being rolled away from. kit leaves tags alone.
    const staleTag = await describe(`${name}/v*`, { cwd: root }).catch(() => undefined)
    const base = { service: name, target: deployed.target, env: deployed.env }

    if (ctx.flags.dryRun) {
      // Nothing runs, the listing included: without --to the version is found at run time.
      const w = plan(ctx.args.to ?? '<previous code version>')
      const to = ctx.args.to ?? 'previous'
      if (ctx.flags.json) emitJson({ dryRun: true, ...base, to, cmd: w.cmd, cwd: cwdOf(w.cwd), staleTag })
      else ctx.log.step(`${cwdOf(w.cwd)} $ ${w.cmd.join(' ')}`)
      return
    }
    if (config.cloudflare?.accountId) pinCloudflareAccount(root, config)
    let to = ctx.args.to
    let picked: import('../../lib/worker').RollbackTarget | undefined
    if (!to) {
      // wrangler's default is the deployment before the latest, and a secret push is a deployment:
      // kit picks the last deployment with different code and names it.
      const list = async (what: 'deployments' | 'versions') => {
        const w = wrangler(root, config, deployed.target, ...listArgs(what, deployed.env))
        return await runPiped(w.cmd, { cwd: w.cwd })
      }
      const deployments = await list('deployments')
      if (deployments.code !== 0) {
        throw new KitError(
          `Could not list ${name}'s deployments (wrangler exited with ${deployments.code})`,
          (deployments.stderr || deployments.stdout).trim().split('\n').at(-1) || undefined,
          ExitCode.precondition,
        )
      }
      // A gradual deployment is live: there is no one version to roll back from, so kit does not guess.
      const split = gradualRollout(deployments.stdout)
      if (split) {
        const lines = split.map((c) => `${c.version}  ${c.deployed}  ${c.percentage}%`)
        throw new KitError(
          `A gradual deployment of ${name} is live, so kit cannot tell which version to roll back to`,
          `Pass one with --to <version-id>:\n    ${lines.join('\n    ')}`,
          ExitCode.precondition,
        )
      }
      // Versions name the secret-only ones; the deployments' own annotations cover a failed listing.
      const versions = await list('versions')
      picked = pickRollback(deployments.stdout, versions.code === 0 ? versions.stdout : '[]')
      if (!picked) {
        throw new KitError(
          `No earlier code version of ${name} among its recent deployments`,
          'Pick one from `kit wrangler <target> versions list` and pass it with --to',
          ExitCode.precondition,
        )
      }
      to = picked.version
    }
    const w = plan(to)
    const where = `${deployed.target}${deployed.env ? ` (${deployed.env})` : ''}`
    const goal = picked ? `version ${to}, deployed ${picked.deployed}` : `version ${to}`
    if (picked?.secretChanges) {
      ctx.log.warn(
        `${picked.secretChanges} secret change${picked.secretChanges === 1 ? '' : 's'} since then revert with it; run \`kit env push\` afterwards`,
      )
    }
    if (!(await confirm(ctx.flags, `Roll ${name} (worker ${where}) back to ${goal}?`))) {
      throw new KitError('Cancelled', undefined, ExitCode.interrupted)
    }
    if (!ctx.flags.json) ctx.log.dim(`${cwdOf(w.cwd)} $ ${w.cmd.join(' ')}`)
    // No terminal on stdin: wrangler ignores --yes, and off a terminal it takes the default for its
    // message, confirmation and changed-secrets prompts. Its output goes to stderr.
    const { code } = await runLines(w.cmd, {
      cwd: w.cwd,
      onLine: (line) => process.stderr.write(`${line}\n`),
    })
    const ok = code === 0
    if (ctx.flags.json) {
      emitJson({
        ...base,
        to,
        ...(picked ? { deployed: picked.deployed, secretChanges: picked.secretChanges } : {}),
        ok,
        ...(ok ? { staleTag } : {}),
      })
    }
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
