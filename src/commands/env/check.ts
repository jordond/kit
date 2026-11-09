import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Validate .env against the schema and check outputs for drift',
  group: 'Infra',
  args: {
    'schema-only': { type: 'boolean', description: 'Validate .env only; skip output drift (CI)' },
  },
  examples: 'kit env check\nkit env check --schema-only\nkit env check --json',
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
    const ok = !state.issues.length && !drift.length

    if (ctx.flags.json) {
      emitJson({ ok, invalid: state.issues, drift })
    } else {
      for (const i of state.issues) ctx.log.error(`${i.key}: ${i.message}`)
      for (const d of drift) {
        const keys = [...d.added, ...d.updated, ...d.removed]
        ctx.log.error(
          `${d.path} ${d.reason}${d.reason === 'stale' && keys.length ? `: ${keys.join(', ')}` : ''}`,
        )
      }
      if (ok) ctx.log.success('env ok')
      else if (state.issues.length) ctx.log.info('  › fix .env, or run `kit env init`')
      else ctx.log.info('  › run `kit env sync`')
    }
    if (!ok) process.exitCode = ExitCode.config
  },
})
