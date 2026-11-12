import { defineCommand } from '../../../cli/command'

export default defineCommand({
  description: 'Upload the store listing text; --screenshots adds images. Never a binary or a review',
  group: 'Release',
  args: {
    screenshots: {
      type: 'boolean',
      description: 'Also replace the screenshots (Play: and the feature graphic and icon)',
    },
  },
  examples:
    'kit release metadata push ios\nkit release metadata push android --screenshots\nkit release metadata push ios --dry-run\nkit release metadata push android --yes',
  async run(ctx) {
    const { requireProject } = await import('../../../cli/command')
    const { metadataPlatform, pushMetadata } = await import('../../../lib/release/metadata')
    requireProject(ctx)
    await pushMetadata(ctx, {
      platform: metadataPlatform('push', ctx.positionals[0]),
      screenshots: ctx.args.screenshots === true,
    })
  },
})
