import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Show the version and the latest build on each store track',
  group: 'Release',
  examples: 'kit release status\nkit release status android\nkit release status ios --json',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { releaseStatus, requirePlatform } = await import('../../lib/release/status')
    requireProject(ctx)
    const platform = ctx.positionals[0]
    await releaseStatus(
      ctx,
      platform === undefined ? undefined : requirePlatform(platform, 'kit release status [ios|android]'),
    )
  },
})
