import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Run code generation; --check fails when the generated files are not committed',
  group: 'Quality',
  args: {
    check: {
      type: 'boolean',
      description: 'Run it, then fail if a codegen output differs from HEAD or is untracked',
    },
  },
  examples: 'kit codegen\nkit codegen --check',
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { assertNoDrift, requireCodegen, runCodegen } = await import('../lib/codegen')
    const { root, config } = requireProject(ctx)
    const codegen = requireCodegen(config)
    if (ctx.flags.dryRun) {
      ctx.log.info(`Would run: ${[codegen.run].flat().join(' && ')}`)
      return
    }
    if (!(await runCodegen(root, codegen, ctx.flags, ctx.flags.bail))) return
    if (ctx.args.check) await assertNoDrift(root, codegen.outputs)
  },
})
