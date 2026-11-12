import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Validate .env, check outputs for drift, and check GitHub has every CI secret',
  group: 'Infra',
  args: {
    'schema-only': {
      type: 'boolean',
      description: 'Validate .env only; skip output drift and GitHub secrets (CI)',
    },
  },
  examples: 'kit env check\nkit env check --schema-only\nkit env check --json',
  // GitHub: names in env.githubSecrets, plus the release secrets for configured platforms when a
  // workflow releases; repo, environment and org secrets count (names only). Skipped with
  // --schema-only, on GitHub Actions, without gh, or when gh can't list (not logged in).
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { loadEnv } = await import('../../lib/env/load')
    const { outputs, checkOutputs } = await import('../../lib/env/render')
    const { emitJson } = await import('../../lib/log')
    const { ExitCode } = await import('../../lib/errors')
    const { root, config } = requireProject(ctx)
    const state = await loadEnv(root, config)
    const drift = ctx.args['schema-only']
      ? []
      : checkOutputs(root, outputs(config, state.schema), state.values)
    const { checkGithubSecrets, skippedGithub } = await import('../../lib/env/github')
    const github = ctx.args['schema-only']
      ? skippedGithub('--schema-only')
      : await checkGithubSecrets(root, config)
    const ok = !state.issues.length && !drift.length && github.status !== 'missing'
    // Lines Bun, dotenv and kit read differently: a warning, since the value in use may still be right.
    const { dotenvAmbiguities } = await import('../../lib/dotenv')
    const dotenv = Bun.file(`${root}/.env`)
    const ambiguous = (await dotenv.exists()) ? dotenvAmbiguities(await dotenv.text()) : []

    if (ctx.flags.json) {
      emitJson({ ok, invalid: state.issues, drift, github, ambiguous })
    } else {
      for (const i of state.issues) ctx.log.error(`${i.key}: ${i.message}`)
      for (const w of ambiguous) ctx.log.warn(`.env:${w.line} ${w.key} ${w.reason}. ${w.hint}`)
      for (const d of drift) {
        const keys = [...d.added, ...d.updated, ...d.removed]
        ctx.log.error(
          `${d.path} ${d.reason}${d.reason === 'stale' && keys.length ? `: ${keys.join(', ')}` : ''}`,
        )
      }
      if (github.status === 'missing') {
        ctx.log.error(
          `GitHub secrets missing: ${github.missing.join(', ')}`,
          'kit env push --github (from .env), or gh secret set',
        )
      } else if (github.status === 'skipped') ctx.log.dim(`- GitHub secrets: skipped (${github.reason})`)
      if (github.optionalMissing.length)
        ctx.log.warn(`GitHub secrets: optional ${github.optionalMissing.join(', ')} unset`)
      if (github.stale.length)
        ctx.log.warn(`GitHub secrets: old names still set, delete once unused: ${github.stale.join(', ')}`)
      if (ok) ctx.log.success(github.status === 'ok' ? 'env ok (GitHub secrets ok)' : 'env ok')
      else if (state.issues.length) ctx.log.info('  › fix .env, or run `kit env init`')
      else if (drift.length) ctx.log.info('  › run `kit env sync`')
    }
    if (!ok) process.exitCode = ExitCode.config
  },
})
