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
    const { run, runToStderr } = await import('../lib/proc')
    const { emitJson } = await import('../lib/log')
    const { root, config } = requireProject(ctx)
    if (config.cloudflare?.accountId) (await import('../lib/cloudflare')).pinCloudflareAccount(root, config)
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
      if (ctx.flags.json) emitJson({ target: name, env, plan })
      else for (const p of plan) ctx.log.step(p)
      return
    }
    // --json: children print to stderr and the one document comes last.
    const exec = ctx.flags.json ? runToStderr : run
    const steps: { title: string; code: number }[] = []
    const report = (ok: boolean) => {
      if (ctx.flags.json) emitJson({ target: name, env, ok, steps })
    }
    for (const b of before) {
      ctx.log.step(b.title)
      const code = await exec(b.cmd, { cwd: root, env: { KIT_ROOT: root } })
      steps.push({ title: b.title, code })
      if (code !== 0) {
        report(false)
        throw new KitError(
          `${b.title} failed (exit ${code}); not deploying`,
          undefined,
          ExitCode.precondition,
        )
      }
    }
    for (const c of cmds) {
      ctx.log.step(c.title)
      const code = await exec(c.cmd, { cwd: c.cwd, env: c.env })
      steps.push({ title: c.title, code })
      if (code !== 0) {
        report(false)
        process.exitCode = ExitCode.failed
        return
      }
    }
    report(true)
    ctx.log.success(`deployed ${name}${env ? ` (${env})` : ''}`)
  },
})
