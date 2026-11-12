import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Boot a simulator or emulator, creating one when none exists',
  group: 'Develop',
  args: { device: { type: 'string', description: 'Simulator name or UDID, or AVD name' } },
  examples:
    'kit device boot ios\nkit device boot android --device pixel_10_pro_xl --yes\nkit device boot ipad --json',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { bootDevice, familyOf, listDevices, noteEmulatorArgsNotApplied, parseTarget, platformOf } =
      await import('../../lib/devices')
    const { preferredAmong } = await import('../../lib/devices/pick')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const target = parseTarget(ctx.positionals[0], 'device boot')
    const env = { root, config, flags: ctx.flags, log: ctx.log }
    const name = ctx.args.device

    if (name === undefined) {
      const running = await listDevices(env, target)
      if (running.length > 0) {
        const device = preferredAmong(platformOf(target), running, familyOf(target))
        if (ctx.flags.json) emitJson({ target, id: device.id, booted: true })
        else ctx.log.success(`Already running: ${device.label}`)
        if (device.id.startsWith('emulator-')) noteEmulatorArgsNotApplied(env)
        return
      }
    }

    const id = await bootDevice(env, target, name)
    const booted = !ctx.flags.dryRun
    if (ctx.flags.json) emitJson({ target, id, booted })
    else if (booted) ctx.log.success(`Booted ${id}`)
    else ctx.log.step(`Would boot ${id}`)
  },
})
