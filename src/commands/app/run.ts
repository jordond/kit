import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Build, install and launch the app',
  group: 'Develop',
  examples:
    'kit app run android\nkit app run ipad\nkit app run android --no-build\nkit app run android --dry-run --json',
  args: {
    device: { type: 'string', description: 'Simulator UDID, adb serial or physical device id' },
    file: { type: 'string', description: 'Install this apk, aab, app or ipa instead of building' },
    'no-build': { type: 'boolean', description: 'Install the newest existing build' },
  },
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { parseTarget } = await import('../../lib/devices')
    const { runApp } = await import('../../lib/app/install')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const target = parseTarget(ctx.positionals[0], 'app run')
    const result = await runApp({ root, config, flags: ctx.flags, log: ctx.log }, target, {
      device: ctx.args.device,
      file: ctx.args.file,
      noBuild: ctx.args['no-build'] === true,
      launch: true,
    })
    if (ctx.flags.json) {
      emitJson({
        target,
        device: result.device,
        artifact: result.artifact ?? null,
        launched: result.launched,
        plan: result.plan,
      })
    } else if (ctx.flags.dryRun) {
      for (const cmd of result.plan) ctx.log.step(cmd.join(' '))
    } else {
      ctx.log.success(`Launched on ${result.device}`)
    }
  },
})
