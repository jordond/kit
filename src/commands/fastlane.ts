import { defineCommand } from '../cli/command'

const DESCRIPTION = "Run fastlane with kit's shared Fastfile and Gemfile (arguments pass through)"
const EXAMPLES =
  'kit fastlane lanes\nkit fastlane ios next_build\nkit fastlane run sentry_check_cli_installed'

export default defineCommand({
  description: DESCRIPTION,
  group: 'Release',
  passthrough: true,
  examples: EXAMPLES,
  async run(ctx) {
    const first = ctx.rest[0]
    if (first === '-h' || first === '--help') {
      process.stdout.write(
        `${DESCRIPTION}\n\nUsage: kit fastlane [fastlane args…]\n\nRuns \`bundle exec fastlane\` in the app's fastlane dir with KIT_FASTFILE,\nBUNDLE_GEMFILE and the ASC/Play key files set from .env.\n\nExamples:\n${EXAMPLES.split(
          '\n',
        )
          .map((e) => `  ${e}`)
          .join('\n')}\n`,
      )
      return
    }
    const { requireProject } = await import('../cli/command')
    const { appFastlaneDir, ensureBundle, fastlaneEnv } = await import('../lib/fastlane')
    const { optionalLaneCreds } = await import('../lib/release/creds')
    const { run } = await import('../lib/proc')
    const { root, config } = requireProject(ctx)
    const appRoot = appFastlaneDir(root, config)
    await ensureBundle(appRoot, (l) => process.stderr.write(`${l}\n`))
    const env = { ...fastlaneEnv(appRoot), ...optionalLaneCreds() }
    process.exitCode = await run(['bundle', 'exec', 'fastlane', ...ctx.rest], { cwd: appRoot, env })
  },
})
