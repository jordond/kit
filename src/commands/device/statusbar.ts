import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Pin the status bar to 9:41 with full signal and battery; --clear restores it',
  group: 'Develop',
  args: {
    device: { type: 'string', description: 'Simulator UDID or adb serial (default: the running one)' },
    clear: { type: 'boolean', description: 'Restore the real status bar' },
  },
  examples:
    'kit device statusbar ios\nkit device statusbar android --clear\nkit device statusbar ipad --dry-run --json',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { adb, listDevices, parseTarget, resolveDevice } = await import('../../lib/devices')
    const { androidStatusBarCommands, iosStatusBarCommands, runStatusBarCommands } =
      await import('../../lib/devices/statusbar')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const target = parseTarget(ctx.positionals[0], 'device statusbar')
    const env = { root, config, flags: ctx.flags, log: ctx.log }
    const clear = !!ctx.args.clear

    // A status bar override only means something on a running device: never offer to boot one.
    if (!ctx.args.device && (await listDevices(env, target)).length === 0) {
      throw new KitError(`No ${target} device is running`, `kit device boot ${target}`, ExitCode.precondition)
    }
    const id = await resolveDevice(env, target, ctx.args.device)
    const plan =
      target === 'android' ? androidStatusBarCommands(adb(env), id, clear) : iosStatusBarCommands(id, clear)

    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ target, id, clear, applied: false, plan })
      else for (const cmd of plan) ctx.log.step(cmd.join(' '))
      return
    }
    await runStatusBarCommands(plan)
    if (ctx.flags.json) emitJson({ target, id, clear, applied: true })
    else ctx.log.success(clear ? `Status bar restored on ${id}` : `Status bar pinned to 9:41 on ${id}`)
  },
})
