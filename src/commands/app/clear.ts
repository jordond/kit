import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: "Wipe the app's data on a device",
  group: 'Develop',
  examples:
    'kit app clear android\nkit app clear ios --device <udid>\nkit app clear android --dry-run --json',
  args: {
    device: { type: 'string', description: 'Simulator UDID, adb serial or physical device id' },
  },
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { parseTarget } = await import('../../lib/devices')
    const { clearApp, requireRunningDevice } = await import('../../lib/app/install')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const target = parseTarget(ctx.positionals[0], 'app clear')
    const env = { root, config, flags: ctx.flags, log: ctx.log }
    const device = await requireRunningDevice(env, target, ctx.args.device)
    const result = await clearApp(env, target, device)
    if (ctx.flags.json) emitJson({ target, device: result.device, plan: result.plan })
    else if (ctx.flags.dryRun) for (const cmd of result.plan) ctx.log.step(cmd.join(' '))
    else ctx.log.success(`Cleared data on ${result.device}`)
  },
})
