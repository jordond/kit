import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'List simulators, emulators and connected devices',
  group: 'Develop',
  args: { booted: { type: 'boolean', description: 'Only devices that are running' } },
  examples: 'kit device list\nkit device list android --booted\nkit device list ios --json',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { deviceTargets, listAllDevices, parseTarget } = await import('../../lib/devices')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const named = ctx.positionals[0]
    const explicit = named !== undefined
    const targets = explicit ? [parseTarget(named, 'device list')] : [...deviceTargets]
    const env = { root, config }

    const devices = []
    for (const target of targets) {
      if (!explicit && target !== 'android' && process.platform !== 'darwin') continue
      try {
        for (const device of await listAllDevices(env, target)) devices.push({ ...device, target })
      } catch (error) {
        // An absent adb must not hide the simulators, unless android is what was asked for.
        if (explicit || !(error instanceof KitError) || error.exitCode !== ExitCode.precondition) throw error
        ctx.log.dim(`skipping ${target}: ${error.message}`)
      }
    }
    const shown = ctx.args.booted ? devices.filter((d) => d.state === 'booted') : devices

    if (ctx.flags.json) {
      emitJson({ devices: shown })
      return
    }
    if (shown.length === 0) {
      ctx.log.info(ctx.args.booted ? 'No running devices' : 'No devices found')
      return
    }
    for (const d of [...shown].sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted'))) {
      const mark = d.state === 'booted' ? '● booted  ' : '○ shutdown'
      const os = d.os ? ` iOS ${d.os}` : ''
      ctx.log.info(`${mark}  ${d.target.padEnd(7)} ${d.name}${os}  ${d.id}`)
    }
  },
})
