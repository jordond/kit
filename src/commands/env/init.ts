import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Create .env from .env.example and ask for missing required keys',
  group: 'Infra',
  examples: 'kit env init\nkit env init --dry-run',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { loadEnv, assertValid } = await import('../../lib/env/load')
    const { planInit, applyInit } = await import('../../lib/env/init')
    const { outputs, writeOutputs } = await import('../../lib/env/render')
    const { password, text } = await import('../../lib/prompt')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const { schema } = await loadEnv(root, config)
    const plan = planInit(root, schema)

    if (ctx.flags.dryRun) {
      const summary = { created: plan.created, backfilled: plan.backfilled, ask: plan.ask.map((k) => k.name) }
      if (ctx.flags.json) emitJson({ dryRun: true, ...summary })
      else {
        if (plan.created) ctx.log.step('would create .env')
        if (plan.backfilled.length) ctx.log.step(`would backfill: ${plan.backfilled.join(', ')}`)
        if (plan.ask.length) ctx.log.step(`would ask for: ${summary.ask.join(', ')}`)
        if (!plan.created && !plan.backfilled.length && !plan.ask.length) ctx.log.success('.env complete')
      }
      return
    }

    // Collect every answer before writing anything.
    const answers: Record<string, string> = {}
    const required = (v: string) => (v.trim() ? undefined : 'Required')
    for (const key of plan.ask) {
      const message = key.description ? `${key.name} (${key.description})` : key.name
      const hint = `Set ${key.name} in .env`
      answers[key.name] = key.secret
        ? await password(ctx.flags, message, { hint, validate: required })
        : await text(ctx.flags, message, { hint, validate: required })
    }

    const parsed = applyInit(root, plan, answers)
    if (!ctx.flags.json) {
      if (plan.created) ctx.log.success('created .env')
      if (plan.backfilled.length) ctx.log.success(`backfilled ${plan.backfilled.join(', ')}`)
      if (plan.ask.length) ctx.log.success(`set ${plan.ask.map((k) => k.name).join(', ')}`)
    }

    // Validate what was written and render outputs from it (the process env predates the answers).
    const state = await loadEnv(root, config, { ...process.env, ...parsed })
    assertValid(state)
    const written = writeOutputs(root, outputs(config, state.schema), state.values).filter((r) => r.changed)
    if (ctx.flags.json) {
      emitJson({
        created: plan.created,
        backfilled: plan.backfilled,
        set: plan.ask.map((k) => k.name),
        outputs: written.map((r) => r.path),
      })
      return
    }
    for (const r of written) ctx.log.success(`wrote ${r.path}`)
  },
})
