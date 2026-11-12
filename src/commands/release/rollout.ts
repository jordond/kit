import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Change the production rollout: Play staged rollout, App Store phased release',
  group: 'Release',
  args: {
    percent: { type: 'number', description: 'Android: staged-rollout percentage, 1-100 (100 completes it)' },
    halt: { type: 'boolean', description: 'Halt the Play rollout, or pause the App Store phased release' },
    resume: { type: 'boolean', description: 'Resume a halted rollout or a paused phased release' },
    complete: { type: 'boolean', description: 'Release to everyone now' },
  },
  examples:
    'kit release rollout android --percent 25\nkit release rollout android --halt\nkit release rollout ios --resume\nkit release rollout ios --complete --dry-run',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { rolloutMobile } = await import('../../lib/release/rollout')
    const { requirePlatform } = await import('../../lib/release/status')
    requireProject(ctx)
    const platform = requirePlatform(
      ctx.positionals[0],
      'kit release rollout <ios|android> [--percent <1-100>] [--halt] [--resume] [--complete]',
    )
    await rolloutMobile(ctx, platform, {
      percent: ctx.args.percent,
      halt: ctx.args.halt,
      resume: ctx.args.resume,
      complete: ctx.args.complete,
    })
  },
})
