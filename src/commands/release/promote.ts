import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Promote a build the store already has to a later track (no rebuild)',
  group: 'Release',
  args: {
    from: { type: 'string', description: 'Source track: alpha | beta (internal builds are never promoted)' },
    to: { type: 'string', description: 'Destination track, later than --from: beta | prod' },
    build: {
      type: 'number',
      description: 'Build number (iOS) or version code (Android); default: the latest on the source track',
    },
    // Not `--version`: that is kit's own global flag.
    'app-version': {
      type: 'string',
      description:
        'iOS: version name of the build, when it predates a version bump (default: the TOML version)',
    },
    rollout: {
      type: 'number',
      description:
        'Android prod staged-rollout fraction, 0 < r <= 1 (default release.android.prodRollout or 0.1)',
    },
    notes: {
      type: 'string',
      description: "Release notes; iOS prod: What's New, required (default: the build keeps its notes)",
    },
    draft: { type: 'boolean', description: 'Android: promote as a draft release' },
    skip: { type: 'string', description: 'Skip release.preflight checks by skipFlag (comma-separated)' },
  },
  examples:
    'kit release promote android --from alpha --to beta --yes\nkit release promote android --from beta --to prod --rollout 0.2\nkit release promote ios --from beta --to prod --build 42 --notes "Bug fixes"\nkit release promote ios --from beta --to prod --app-version 1.3.0 --build 40 --notes "Hotfix"\nkit release promote ios --from alpha --to beta --dry-run',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { promoteMobile, validatePromotion } = await import('../../lib/release/promote')
    const { requirePlatform } = await import('../../lib/release/status')
    requireProject(ctx)
    const platform = requirePlatform(
      ctx.positionals[0],
      'kit release promote <ios|android> --from <alpha|beta> --to <beta|prod>',
    )
    await promoteMobile(ctx, {
      platform,
      ...validatePromotion(ctx.args.from, ctx.args.to),
      build: ctx.args.build,
      version: ctx.args['app-version'],
      rollout: ctx.args.rollout,
      notes: ctx.args.notes,
      draft: ctx.args.draft,
      skip: (ctx.args.skip ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })
  },
})
