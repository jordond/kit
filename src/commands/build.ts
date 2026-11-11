import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Build every target',
  group: 'Develop',
  args: {
    release: { type: 'boolean', description: 'Gradle or Kotlin toolchain: the signed release bundle (AAB)' },
    apk: { type: 'boolean', description: 'Gradle: the signed release APK' },
  },
  examples: 'kit build\nkit build api admin\nkit build client --release',
  async run(ctx) {
    const { runVerb } = await import('./_verb')
    const { ExitCode, KitError } = await import('../lib/errors')
    if (ctx.args.release && ctx.args.apk) {
      throw new KitError('--release and --apk build different artifacts; pick one', undefined, ExitCode.usage)
    }
    const release = ctx.args.release ? 'aab' : ctx.args.apk ? 'apk' : undefined
    if (release) {
      const name = ctx.positionals[0]
      const t = name ? ctx.config?.targets[name] : undefined
      if (ctx.positionals.length !== 1 || (t?.kind !== 'gradle' && t?.kind !== 'kotlin')) {
        throw new KitError(
          'A release build is for one gradle or kotlin target',
          'Name it, e.g. `kit build client --release`',
          ExitCode.usage,
        )
      }
    }
    await runVerb(ctx, { name: 'build', verbs: ['build'], plan: { release } })
  },
})
