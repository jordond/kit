import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Push secrets to Cloudflare workers (wrangler) and GitHub Actions (gh)',
  group: 'Infra',
  args: {
    target: { type: 'string', short: 't', description: 'Only this worker target (env.workerSecrets)' },
    github: { type: 'boolean', description: 'Push env.githubSecrets with gh' },
    all: { type: 'boolean', description: 'Every worker and GitHub; the default, kept for scripts' },
  },
  examples: [
    'kit env push                    # every worker in env.workerSecrets and env.githubSecrets',
    'kit env push --target edge',
    'kit env push --github           # GitHub Actions secrets only',
    'kit env push --target edge --github',
    'kit env push --yes              # everything, no prompt (CI)',
    'kit env push --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { loadEnv, assertValid } = await import('../../lib/env/load')
    const { executePush, githubDestination, planPush, workerDestination } = await import('../../lib/env/push')
    const { pinCloudflareAccount } = await import('../../lib/cloudflare')
    const { confirm } = await import('../../lib/prompt')
    const { emitJson } = await import('../../lib/log')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { root, config } = requireProject(ctx)
    const state = await loadEnv(root, config)
    assertValid(state)

    // No flags (or --all): every worker and GitHub (when env.githubSecrets is set).
    // --target: that worker. --github alone: GitHub only. Both: that worker and GitHub.
    if (ctx.args.all && ctx.args.target) {
      throw new KitError('--all and --target are exclusive', 'kit env push --all', ExitCode.usage)
    }
    const everything = ctx.args.all || (!ctx.args.target && !ctx.args.github)
    const workerNames = ctx.args.target
      ? [ctx.args.target]
      : everything
        ? Object.keys(config.env?.workerSecrets ?? {})
        : []
    const destinations = workerNames.map((t) => workerDestination(root, config, t))
    if (everything && config.env?.githubSecrets?.length) {
      destinations.push(githubDestination(root, config.env.githubSecrets))
    } else if (ctx.args.github && !everything) {
      const keys = config.env?.githubSecrets ?? []
      if (!keys.length) {
        throw new KitError(
          'No env.githubSecrets configured',
          'Add env.githubSecrets in kit.config.ts',
          ExitCode.usage,
        )
      }
      destinations.push(githubDestination(root, keys))
    }
    if (!destinations.length) {
      throw new KitError(
        'Nothing to push',
        'Add env.workerSecrets or env.githubSecrets in kit.config.ts',
        ExitCode.usage,
      )
    }
    if (workerNames.length) pinCloudflareAccount(root, config)

    const plans = []
    for (const d of destinations)
      plans.push(await planPush(d, state.values, { proceedOnListFailure: ctx.flags.yes }))
    const toPush = plans.flatMap((p) =>
      p.items.filter((i) => i.status === 'new' || i.status === 'overwrite' || i.status === 'unknown'),
    )
    // A remote kit could not list (bad wrangler or gh auth) is a failure, even if nothing else is left to push.
    const listFailed = plans.filter((p) => p.items.some((i) => i.status === 'list-failed'))

    if (!ctx.flags.json) {
      for (const p of plans) {
        ctx.log.info(p.destination.name)
        if (p.listError) ctx.log.warn(`could not list existing secrets: ${p.listError}`)
        for (const i of p.items) ctx.log.dim(`  ${i.key}  ${i.status}`)
      }
      if (listFailed.length)
        ctx.log.warn('Skipping remotes kit could not list; re-run with --yes to push anyway')
    }

    const report = (outcomes: { destination: string; key: string; status: string }[], ok: boolean) => {
      if (ctx.flags.json) emitJson({ dryRun: ctx.flags.dryRun, ok, outcomes })
    }

    const failListed = () => {
      if (!listFailed.length) return
      if (!ctx.flags.json) {
        ctx.log.error(`could not list secrets on ${listFailed.map((p) => p.destination.name).join(', ')}`)
      }
      process.exitCode = ExitCode.failed
    }

    if (ctx.flags.dryRun || !toPush.length) {
      report(
        plans.flatMap((p) =>
          p.items.map((i) => ({ destination: p.destination.name, key: i.key, status: i.status })),
        ),
        !listFailed.length,
      )
      if (!ctx.flags.json && !toPush.length && !listFailed.length) ctx.log.warn('Nothing to push')
      failListed()
      return
    }

    const where = plans.map((p) => p.destination.name).join(', ')
    if (!(await confirm(ctx.flags, `Push ${toPush.length} secret(s) to ${where}?`))) {
      throw new KitError('Cancelled', undefined, ExitCode.interrupted)
    }

    const outcomes = await executePush(plans, state.values, (dest, key) => {
      if (!ctx.flags.json) ctx.log.step(`${key} → ${dest}`)
    })
    const failed = outcomes.find((o) => o.status === 'failed')
    report(outcomes, !failed && !listFailed.length)
    if (failed) {
      if (!ctx.flags.json) {
        ctx.log.error(`push ${failed.key} → ${failed.destination} failed`)
        if (failed.output?.trim()) process.stderr.write(`${failed.output.trim()}\n`)
      }
      process.exitCode = ExitCode.failed
      return
    }
    if (!ctx.flags.json) {
      const pushed = outcomes.filter((o) => o.status === 'pushed').length
      ctx.log.success(`pushed ${pushed}, skipped ${outcomes.length - pushed}`)
    }
    failListed()
  },
})
