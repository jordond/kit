import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Remove the app from a device',
  group: 'Develop',
  examples:
    'kit app uninstall android\nkit app uninstall ios --device <udid>\nkit app uninstall android --dry-run --json',
  args: {
    device: { type: 'string', description: 'Simulator UDID, adb serial or physical device id' },
  },
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { parseTarget } = await import('../../lib/devices')
    const { uninstallApp, requireRunningDevice } = await import('../../lib/app/install')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const target = parseTarget(ctx.positionals[0], 'app uninstall')
    const env = { root, config, flags: ctx.flags, log: ctx.log }
    const device = await requireRunningDevice(env, target, ctx.args.device)
    const result = await uninstallApp(env, target, device)
    if (ctx.flags.json) emitJson({ target, device: result.device, plan: result.plan })
    else if (ctx.flags.dryRun) for (const cmd of result.plan) ctx.log.step(cmd.join(' '))
    else ctx.log.success(`Uninstalled from ${result.device}`)
  },
})
