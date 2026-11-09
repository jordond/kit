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
