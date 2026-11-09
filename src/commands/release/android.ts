import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Build and upload Android to a Play track',
  group: 'Release',
  args: {
    track: {
      type: 'enum',
      short: 't',
      choices: ['internal', 'alpha', 'beta', 'prod'],
      required: true,
      description: 'Play internal testing · closed (alpha) · open (beta) · production (prod)',
    },
    code: { type: 'number', description: 'Version code (default: max across Play tracks + 1)' },
    notes: {
      type: 'string',
      description: 'Release notes (default: commits since the last android/v* tag; clamped to 500)',
    },
    rollout: {
      type: 'number',
      description: 'prod staged-rollout fraction, 0 < r <= 1 (default release.android.prodRollout or 0.1)',
    },
    draft: {
      type: 'boolean',
      description: 'Upload as a draft release (required while the Play app is a draft)',
    },
    skip: { type: 'string', description: 'Skip release.preflight checks by skipFlag (comma-separated)' },
  },
  examples:
    'kit release android --track internal\nkit release android --track prod --rollout 0.2\nkit release android --track alpha --draft\nkit release android --track internal --dry-run',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { releaseMobile } = await import('../../lib/release/mobile')
    requireProject(ctx)
    await releaseMobile(ctx, {
      platform: 'android',
      track: ctx.args.track,
      build: ctx.args.code,
      notes: ctx.args.notes,
      rollout: ctx.args.rollout,
      draft: ctx.args.draft,
      skip: (ctx.args.skip ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })
  },
})
