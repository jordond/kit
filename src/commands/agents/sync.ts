import { defineCommand } from '../../cli/command'

/**
 * `kit agents sync`: the guide into AGENTS.md (only the block between kit's markers), an
 * `@AGENTS.md` import in CLAUDE.md, and with `--hooks` the Claude Code hook in
 * `.claude/settings.json`. A hook that is already installed is kept up to date without the flag.
 */
export default defineCommand({
  description: 'Write the guide into AGENTS.md; --hooks adds the Claude Code hook',
  group: 'Setup',
  args: {
    hooks: {
      type: 'boolean',
      description: 'Also add the Claude Code PreToolUse hook to .claude/settings.json',
    },
  },
  examples: 'kit agents sync\nkit agents sync --hooks\nkit agents sync --dry-run',
  async run(ctx) {
    const pc = (await import('picocolors')).default
    const { requireProject } = await import('../../cli/command')
    const { agentPlan, applyAgents } = await import('../../lib/agents')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const plan = agentPlan(root, config, ctx.args.hooks ? true : 'keep')
    if (!ctx.flags.dryRun) applyAgents(root, plan)
    if (ctx.flags.json) {
      emitJson({
        files: plan.map((a) => (a.kind === 'skip' ? a : { kind: a.kind, path: a.path, note: a.note })),
      })
      return
    }
    for (const a of plan) {
      if (a.kind === 'skip') ctx.log.dim(`- ${a.path}  ${a.reason}`)
      else ctx.log.step(`${a.kind} ${a.path}  ${pc.dim(a.note)}`)
    }
    if (plan.every((a) => a.kind === 'skip')) ctx.log.info('nothing to write')
  },
})
