import { defineCommand } from '../../../cli/command'

export default defineCommand({
  description: 'Download the store listing into release.<platform>.metadata',
  group: 'Release',
  args: {
    force: { type: 'boolean', description: 'Overwrite uncommitted changes in the metadata directory' },
  },
  examples:
    'kit release metadata pull ios\nkit release metadata pull android\nkit release metadata pull ios --force',
  async run(ctx) {
    const { requireProject } = await import('../../../cli/command')
    const { metadataPlatform, pullMetadata } = await import('../../../lib/release/metadata')
    requireProject(ctx)
    await pullMetadata(ctx, {
      platform: metadataPlatform('pull', ctx.positionals[0]),
      force: ctx.args.force === true,
    })
  },
})
