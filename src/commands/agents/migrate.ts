import pkg from '../../../package.json' with { type: 'json' }
import { defineCommand } from '../../cli/command'

/**
 * `kit agents migrate`: a prompt on stdout for a coding agent that moves this repo onto kit. Runs
 * without a kit config (that is the point; it then scans the git root); in a repo that has one,
 * the prompt says the migration has started. Hand it to an interactive agent session, since the
 * prompt has the agent stop for the user's approval: `claude "$(kit agents migrate)"`.
 */
export default defineCommand({
  description: 'Print a prompt for a coding agent to migrate this repo to kit',
  group: 'Setup',
  examples: 'kit agents migrate\nclaude "$(kit agents migrate)"\nkit agents migrate --json',
  async run(ctx) {
    const { migrateFacts, migratePrompt, migrateRoot } = await import('../../lib/agents-migrate')
    const { emitJson } = await import('../../lib/log')
    const facts = migrateFacts(ctx.root ?? migrateRoot(process.cwd()), ctx.config)
    const prompt = migratePrompt(facts, pkg.version)
    if (ctx.flags.json) emitJson({ prompt, facts })
    else process.stdout.write(`${prompt}\n`)
  },
})
