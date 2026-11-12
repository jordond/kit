import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Push secrets to Cloudflare workers (wrangler) and GitHub Actions (gh)',
  group: 'Infra',
  args: {
    target: { type: 'string', short: 't', description: 'Only this worker target (env.workerSecrets)' },
    github: { type: 'boolean', description: 'Push env.githubSecrets with gh' },
    all: { type: 'boolean', description: 'Every worker and GitHub; the default, kept for scripts' },
    workers: { type: 'boolean', description: 'Every worker in env.workerSecrets; GitHub skipped' },
  },
  examples: [
    'kit env push                    # every worker in env.workerSecrets and env.githubSecrets',
    'kit env push --workers          # every worker, GitHub skipped',
    'kit env push --target edge',
    'kit env push --github           # GitHub Actions secrets only',
    'kit env push --target edge --github',
    'kit env push --yes              # everything, no prompt (CI)',
    'kit env push --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { loadEnv, assertValid } = await import('../../lib/env/load')
    const { assertSelection, runPush } = await import('../../lib/env/push-run')
    const { emitJson } = await import('../../lib/log')
    const { ExitCode } = await import('../../lib/errors')
    const { root, config } = requireProject(ctx)
    const selection = {
      target: ctx.args.target,
      github: ctx.args.github,
      all: ctx.args.all,
      workers: ctx.args.workers,
    }
    assertSelection(selection)
    const state = await loadEnv(root, config)
    assertValid(state)

    const report = await runPush(ctx, root, config, state.values, selection)
    if (ctx.flags.json) emitJson({ dryRun: report.dryRun, ok: report.ok, outcomes: report.outcomes })
    if (!report.ok) process.exitCode = ExitCode.failed
  },
})
