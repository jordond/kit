import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Render env outputs (.dev.vars) from .env',
  group: 'Infra',
  examples: 'kit env sync\nkit env sync --dry-run\nkit env sync --json',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { loadEnv, assertValid } = await import('../../lib/env/load')
    const { outputs, writeOutputs } = await import('../../lib/env/render')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const state = await loadEnv(root, config)
    assertValid(state)
    const results = writeOutputs(root, outputs(config, state.schema), state.values, ctx.flags.dryRun)

    if (ctx.flags.json) {
      emitJson({ dryRun: ctx.flags.dryRun, outputs: results })
      return
    }
    if (!results.length) {
      ctx.log.warn('No env.outputs configured')
      return
    }
    const verb = ctx.flags.dryRun ? 'would write' : 'wrote'
    for (const r of results) {
      if (!r.changed) {
        ctx.log.dim(`  ${r.path} up to date`)
        continue
      }
      const keys = [
        ...r.added.map((k) => `+${k}`),
        ...r.updated.map((k) => `~${k}`),
        ...r.removed.map((k) => `-${k}`),
      ]
      ctx.log.success(`${verb} ${r.path}${keys.length ? `  ${keys.join(' ')}` : ''}`)
    }
  },
})
