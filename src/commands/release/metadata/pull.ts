import { defineCommand } from '../../../cli/command'

export default defineCommand({
  description: 'Download the store listing text into release.<platform>.metadata; --screenshots adds images',
  group: 'Release',
  args: {
    screenshots: {
      type: 'boolean',
      description: 'Also download the screenshots (Play: and the feature graphic and icon)',
    },
    force: { type: 'boolean', description: 'Overwrite uncommitted changes in what the pull writes' },
  },
  examples:
    'kit release metadata pull ios\nkit release metadata pull android --screenshots\nkit release metadata pull ios --force',
  async run(ctx) {
    const { requireProject } = await import('../../../cli/command')
    const { metadataPlatform, pullMetadata } = await import('../../../lib/release/metadata')
    requireProject(ctx)
    await pullMetadata(ctx, {
      platform: metadataPlatform('pull', ctx.positionals[0]),
      force: ctx.args.force === true,
      screenshots: ctx.args.screenshots === true,
    })
  },
})
