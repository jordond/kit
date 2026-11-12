import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Build the debug app for a platform and print the artifact path',
  group: 'Develop',
  examples:
    'kit app build android\nAPK=$(kit app build android)\nkit app build ios --device <udid>\nkit app build android --release\nkit app build android --dry-run --json',
  args: {
    release: { type: 'boolean', description: 'Build the release variant instead of debug' },
    device: { type: 'string', description: 'Simulator UDID the iOS build targets' },
  },
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { parseTarget } = await import('../../lib/devices')
    const { buildApp, buildPlan, requireMac } = await import('../../lib/app/build')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const platform = parseTarget(ctx.positionals[0], 'app build', ['ios', 'android'] as const)
    const opts = { release: ctx.args.release === true, device: ctx.args.device }
    if (ctx.flags.dryRun) {
      const plan = buildPlan(root, config, platform, opts)
      if (ctx.flags.json) emitJson({ platform, plan: [plan.cmd], artifactDir: plan.artifactDir })
      else ctx.log.step(`${plan.cmd.join(' ')}   (in ${plan.cwd}; artifact in ${plan.artifactDir})`)
      return
    }
    if (platform === 'ios') requireMac('kit app build ios')
    const built = await buildApp({ root, config, log: ctx.log }, platform, opts)
    if (ctx.flags.json) emitJson({ platform, artifact: built.artifact, cmd: built.cmd })
    else process.stdout.write(`${built.artifact}\n`)
  },
})
