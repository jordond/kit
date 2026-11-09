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
    const { laneConfigEnv } = await import('../lib/release/mobile')
    const { run } = await import('../lib/proc')
    const { root, config } = requireProject(ctx)
    const appRoot = appFastlaneDir(root, config)
    await ensureBundle(appRoot, (l) => process.stderr.write(`${l}\n`))
    // Same inputs `kit release` passes; stdio stays inherited so match/fastlane prompts work, which
    // means output here is not redacted.
    const env = { ...fastlaneEnv(appRoot), ...laneConfigEnv(root, config), ...optionalLaneCreds() }
    process.exitCode = await run(['bundle', 'exec', 'fastlane', ...ctx.rest], { cwd: appRoot, env })
  },
})
