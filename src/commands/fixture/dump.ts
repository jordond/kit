import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: "Capture the app's state from a device into a fixture",
  group: 'Develop',
  examples:
    'kit fixture dump android sample\nkit fixture dump ios sample --device <udid>\nkit fixture dump android sample --dry-run --json',
  args: {
    device: { type: 'string', description: 'Simulator UDID or adb serial (default: the running one)' },
  },
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { parseTarget } = await import('../../lib/devices')
    const { requireRunningDevice } = await import('../../lib/app/install')
    const { dumpFixture, fixtureConfig } = await import('../../lib/fixtures')
    const { checkName } = await import('../../lib/fixtures/config')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const target = parseTarget(ctx.positionals[0], 'fixture dump')
    const given = ctx.positionals[1]
    if (given === undefined) {
      throw new KitError(
        'kit fixture dump needs a fixture name',
        `kit fixture dump ${target} <name>`,
        ExitCode.usage,
      )
    }
    const name = checkName(given)
    fixtureConfig(root, config)
    const env = { root, config, flags: ctx.flags, log: ctx.log }
    const device = await requireRunningDevice(env, target, ctx.args.device)
    const result = await dumpFixture(env, target, device, name)
    if (ctx.flags.dryRun) {
      if (ctx.flags.json)
        emitJson({ target, device: result.device, fixture: name, files: result.files, plan: result.plan })
      else for (const line of result.plan ?? []) ctx.log.step(line)
      return
    }
    if (ctx.flags.json) emitJson({ target, ...result })
    else {
      ctx.log.success(`Dumped ${name} from ${result.device} (via ${result.via})`)
      for (const file of result.files) ctx.log.info(`  ${file}`)
    }
  },
})
