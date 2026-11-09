import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Run ./gradlew in the Gradle root (arguments pass through)',
  group: 'Develop',
  passthrough: true,
  examples: 'kit gradle assembleDebug\nkit gradle :shared:test --info\nkit gradle --help',
  async run(ctx) {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { requireProject } = await import('../cli/command')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { run } = await import('../lib/proc')
    const { root, config } = requireProject(ctx)
    if (!config.gradle) {
      throw new KitError('No Gradle root configured', 'Set gradle.root in kit.config.ts', ExitCode.config)
    }
    const dir = join(root, config.gradle.root)
    if (!existsSync(join(dir, 'gradlew'))) {
      throw new KitError(
        `${config.gradle.root}/gradlew not found`,
        'Check gradle.root in kit.config.ts',
        ExitCode.config,
      )
    }
    process.exitCode = await run(['./gradlew', ...ctx.rest], { cwd: dir })
  },
})
