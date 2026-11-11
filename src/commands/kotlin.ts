import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Run the Kotlin toolchain wrapper in toolchain.root (arguments pass through)',
  group: 'Develop',
  passthrough: true,
  examples:
    'kit kotlin build -m shared\nkit kotlin run -m desktopApp\nkit kotlin show settings -m androidApp',
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { run } = await import('../lib/proc')
    const { requireWrapper, WRAPPER } = await import('../lib/toolchain')
    const { root, config } = requireProject(ctx)
    const dir = requireWrapper(root, config)
    process.exitCode = await run([WRAPPER, ...ctx.rest], { cwd: dir })
  },
})
