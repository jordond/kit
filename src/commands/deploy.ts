import { defineCommand } from '../cli/command'
import type { KitConfig } from '../config/schema'
import { ExitCode, KitError } from '../lib/errors'

/** Validate `--env` against `targets.<t>.envs`. */
export function checkEnv(config: KitConfig, name: string, env: string | undefined): string | undefined {
  const envs = config.targets[name]?.envs
  if (env && envs && !envs.includes(env)) {
    throw new KitError(`Unknown env "${env}" for ${name}`, `Envs: ${envs.join(', ')}`, ExitCode.usage)
  }
  if (env && !envs) {
    throw new KitError(
      `Target "${name}" has no envs`,
      `Add targets.${name}.envs in kit.config.ts`,
      ExitCode.usage,
    )
  }
  return env
}

/** `deploy.before` entries are kit commands (`env sync`), run as child kit processes. */
export function beforeCommands(config: KitConfig, name: string): string[][] {
  const d = config.targets[name]?.deploy
  const before = d && typeof d === 'object' && !Array.isArray(d) ? (d.before ?? []) : []
  return before.map((s) => s.trim().split(/\s+/))
}

export default defineCommand({
  description: 'Deploy a target',
  group: 'Develop',
  args: {
    env: { type: 'string', short: 'e', description: 'Environment (when the target has envs)' },
  },
  examples: 'kit deploy api\nkit deploy web --env staging\nkit deploy api --dry-run',
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { singleTarget } = await import('./_verb')
    const { targetCommands } = await import('../lib/targets')
    const { run } = await import('../lib/proc')
    const { root, config } = requireProject(ctx)
    const name = singleTarget(ctx, 'deploy')
    const env = checkEnv(config, name, ctx.args.env)
    const cmds = targetCommands(root, config, name, 'deploy', { env, extra: ctx.rest })
    if (!cmds) {
      throw new KitError(
        `Target "${name}" has no deploy command`,
        `Set targets.${name}.deploy in kit.config.ts`,
        ExitCode.usage,
      )
    }
    const self = [process.execPath, '--no-env-file', process.argv[1]!]
    const before = beforeCommands(config, name).map((args) => ({
      title: `kit ${args.join(' ')}`,
      cmd: [...self, ...args, ...(ctx.flags.yes ? ['--yes'] : [])],
    }))
    const plan = [...before.map((b) => b.title), ...cmds.map((c) => c.cmd.join(' '))]
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) process.stdout.write(`${JSON.stringify({ target: name, env, plan }, null, 2)}\n`)
      else for (const p of plan) ctx.log.step(p)
      return
    }
    for (const b of before) {
      ctx.log.step(b.title)
      const code = await run(b.cmd, { cwd: root, env: { KIT_ROOT: root } })
      if (code !== 0) {
        throw new KitError(
          `${b.title} failed (exit ${code}); not deploying`,
          undefined,
          ExitCode.precondition,
        )
      }
    }
    for (const c of cmds) {
      ctx.log.step(c.title)
      const code = await run(c.cmd, { cwd: c.cwd, env: c.env })
      if (code !== 0) {
        process.exitCode = 1
        return
      }
    }
    ctx.log.success(`deployed ${name}${env ? ` (${env})` : ''}`)
  },
})
