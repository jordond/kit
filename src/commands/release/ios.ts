import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Build and upload iOS to a track',
  group: 'Release',
  args: {
    track: {
      type: 'enum',
      short: 't',
      choices: ['internal', 'alpha', 'beta', 'prod'],
      required: true,
      description: 'internal: TestFlight internal · alpha/beta: TestFlight group · prod: App Store',
    },
    build: { type: 'number', description: 'Build number (default: max in App Store Connect + 1)' },
    notes: {
      type: 'string',
      description: "Release notes (default: commits since the last ios/v* tag); prod: What's New, required",
    },
    skip: { type: 'string', description: 'Skip release.preflight checks by skipFlag (comma-separated)' },
  },
  examples:
    'kit release ios --track internal\nkit release ios --track beta --yes\nkit release ios --track prod --notes "Bug fixes"\nkit release ios --track internal --dry-run',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { releaseMobile } = await import('../../lib/release/mobile')
    requireProject(ctx)
    await releaseMobile(ctx, {
      platform: 'ios',
      track: ctx.args.track,
      build: ctx.args.build,
      notes: ctx.args.notes,
      skip: (ctx.args.skip ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })
  },
})
