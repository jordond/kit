import { defineCommand } from '../../cli/command'

/** `kit agents guide`: the kit block of AGENTS.md on stdout, generated from the config as it is now. */
export default defineCommand({
  description: 'Print the guide that tells coding agents how to drive this repo with kit',
  group: 'Setup',
  examples: 'kit agents guide\nkit agents guide --json',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { agentGuide, guideFacts } = await import('../../lib/agents')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const guide = agentGuide(config, guideFacts(root, config))
    if (ctx.flags.json) emitJson({ guide })
    else process.stdout.write(`${guide}\n`)
  },
})
