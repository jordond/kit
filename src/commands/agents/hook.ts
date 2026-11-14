import { defineCommand } from '../../cli/command'

/**
 * `kit agents hook`: what `.claude/settings.json` runs before every Bash tool call. It reads the
 * hook's JSON from stdin and exits 2 with the reason on stderr (Claude Code then blocks the call
 * and shows the reason to the model) when the command builds or tests through `./kotlin` or
 * `./gradlew` directly. Anything it cannot read, and any other command, passes: a hook must never
 * be why an unrelated command fails.
 */
export default defineCommand({
  description: 'The Claude Code PreToolUse hook: refuse a direct ./kotlin or ./gradlew build or test',
  group: 'Setup',
  examples: `echo '{"tool_name":"Bash","tool_input":{"command":"./kotlin build -m core"}}' | kit agents hook`,
  async run(ctx) {
    if (!ctx.config) return
    let command: unknown
    try {
      const input = JSON.parse(await Bun.stdin.text()) as {
        tool_name?: string
        tool_input?: { command?: unknown }
      }
      if (input.tool_name !== undefined && input.tool_name !== 'Bash') return
      command = input.tool_input?.command
    } catch {
      return
    }
    if (typeof command !== 'string') return
    const { hookVerdict } = await import('../../lib/agents')
    const reason = hookVerdict(command, ctx.config)
    if (reason === undefined) return
    process.stderr.write(`${reason}\n`)
    process.exitCode = 2
  },
})
