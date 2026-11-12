import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Replay a fixture (app state) onto a device',
  group: 'Develop',
  examples:
    'kit fixture load android\nkit fixture load ios sample\nkit fixture load ipad sample --device <udid>\nkit fixture load android --dry-run --json',
  args: {
    device: { type: 'string', description: 'Simulator UDID or adb serial (default: the running one)' },
  },
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { parseTarget } = await import('../../lib/devices')
    const { requireRunningDevice } = await import('../../lib/app/install')
    const { fixtureConfig, loadFixture, resolveFixtureName } = await import('../../lib/fixtures')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const target = parseTarget(ctx.positionals[0], 'fixture load')
    const env = { root, config, flags: ctx.flags, log: ctx.log }
    // Name and config problems come before a device is looked for.
    const name = resolveFixtureName(fixtureConfig(root, config), ctx.positionals[1])
    const device = await requireRunningDevice(env, target, ctx.args.device)
    const result = await loadFixture(env, target, device, name)
    if (ctx.flags.dryRun) {
      if (ctx.flags.json)
        emitJson({ target, device: result.device, fixture: name, files: result.files, plan: result.plan })
      else for (const line of result.plan ?? []) ctx.log.step(line)
      return
    }
    if (ctx.flags.json) emitJson({ target, ...result })
    else ctx.log.success(`Loaded ${name} onto ${result.device} (via ${result.via})`)
  },
})
