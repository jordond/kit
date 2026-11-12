import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Run the Maestro CLI (arguments pass through)',
  group: 'Develop',
  passthrough: true,
  examples: 'kit maestro studio\nkit maestro hierarchy\nkit maestro --version',
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { maestroBin, maestroEnv } = await import('../lib/maestro/bin')
    const { run } = await import('../lib/proc')
    // Works without a maestro block: all it needs is the binary.
    const { root, config } = requireProject(ctx)
    process.exitCode = await run([maestroBin(config), ...ctx.rest], { cwd: root, env: maestroEnv(ctx.flags) })
  },
})
