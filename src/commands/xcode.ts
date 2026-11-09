import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineCommand } from '../cli/command'
import type { KitConfig } from '../config/schema'

/**
 * The iOS project to open, repo-relative: `release.ios.project`, else the first workspace (then
 * project) under `<gradle root>/ios`. A workspace wins so CocoaPods setups open whole.
 */
export function findIosProject(root: string, config: KitConfig): string | undefined {
  if (config.release?.ios?.project) return config.release.ios.project
  if (!config.gradle) return undefined
  const ios = join(config.gradle.root, 'ios')
  if (!existsSync(join(root, ios))) return undefined
  const entries = readdirSync(join(root, ios)).sort()
  const pick =
    entries.find((e) => e.endsWith('.xcworkspace')) ?? entries.find((e) => e.endsWith('.xcodeproj'))
  return pick ? join(ios, pick) : undefined
}

export default defineCommand({
  description: 'Open the iOS project in Xcode',
  group: 'Develop',
  examples: 'kit xcode',
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { run } = await import('../lib/proc')
    const { root, config } = requireProject(ctx)
    if (process.platform !== 'darwin') {
      throw new KitError('kit xcode requires macOS', undefined, ExitCode.precondition)
    }
    const project = findIosProject(root, config)
    if (!project) {
      throw new KitError(
        'No iOS project found',
        'Set release.ios.project in kit.config.ts, or add one under <gradle root>/ios',
        ExitCode.config,
      )
    }
    if (!existsSync(join(root, project))) {
      throw new KitError(
        `${project} not found`,
        'Check release.ios.project in kit.config.ts',
        ExitCode.config,
      )
    }
    const cmd = ['open', '-a', 'Xcode', project]
    if (ctx.flags.dryRun) {
      ctx.log.step(cmd.join(' '))
      return
    }
    const code = await run(cmd, { cwd: root })
    if (code !== 0) throw new KitError(`${cmd.join(' ')} failed (exit ${code})`, 'Is Xcode installed?')
    ctx.log.success(`Opening ${project} in Xcode`)
  },
})
