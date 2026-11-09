import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Build and upload Android to a track',
  group: 'Release',
  args: {
    track: {
      type: 'enum',
      choices: ['internal', 'alpha', 'beta', 'prod'],
      required: true,
      description: 'Store track',
    },
    build: { type: 'number', description: 'Override the store build number' },
  },
  examples: 'kit release android --track beta\nkit release android --track internal --dry-run',
  run(ctx) {
    ctx.log.step(`release android → ${ctx.args.track}${ctx.flags.dryRun ? ' (dry run)' : ''}`)
  },
})
