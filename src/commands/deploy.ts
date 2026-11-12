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

/**
 * `--env` across several targets: targets that declare `envs` get it (an unknown env is a usage
 * error), targets without envs run their default. An env none of the targets declares is a usage error.
 */
export function envsFor(
  config: KitConfig,
  names: string[],
  env: string | undefined,
): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  if (!env) {
    for (const n of names) out.set(n, undefined)
    return out
  }
  const withEnvs = names.filter((n) => config.targets[n]?.envs)
  if (!withEnvs.length) {
    if (names.length === 1) checkEnv(config, names[0]!, env)
    throw new KitError(
      `--env ${env} applies to none of ${names.join(', ')}`,
      'Add targets.<name>.envs in kit.config.ts',
      ExitCode.usage,
    )
  }
  for (const n of names) out.set(n, withEnvs.includes(n) ? checkEnv(config, n, env) : undefined)
  return out
}

/** `deploy.before` entries are kit commands (`env sync`), run as child kit processes. */
export function beforeCommands(config: KitConfig, name: string): string[][] {
  const d = config.targets[name]?.deploy
  const before = d && typeof d === 'object' && !Array.isArray(d) ? (d.before ?? []) : []
  return before.map((s) => s.trim().split(/\s+/))
}

interface DeployResult {
  target: string
  env?: string
  ok: boolean
  /** Wall-clock time of this target's steps. */
  ms: number
  steps: { title: string; code: number; ms: number }[]
}

export default defineCommand({
  description: 'Deploy one or more targets, in order (deploy.before first)',
  group: 'Develop',
  args: {
    env: { type: 'string', short: 'e', description: 'Environment, for targets that declare envs' },
    preview: {
      type: 'boolean',
      description: 'Worker targets: upload a preview version, leave production traffic; prints its URL',
    },
    comment: { type: 'boolean', description: "With --preview: post or update the URL on the branch's PR" },
  },
  examples: [
    'kit deploy api',
    'kit deploy api admin web          # in order; stops at the first failure',
    'kit deploy web --env staging',
    'kit deploy api web --env staging  # the env goes to the targets that declare it',
    'kit deploy api --dry-run --json',
    'kit deploy api --preview          # wrangler versions upload; the preview URL on stdout',
    'kit deploy api --preview --comment',
  ].join('\n'),
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { selectTargets, targetCommands } = await import('../lib/targets')
    const { run, runToStderr } = await import('../lib/proc')
    const { emitJson } = await import('../lib/log')
    const { root, config } = requireProject(ctx)
    const names = ctx.positionals.length ? selectTargets(config, ctx.positionals).targets.map(([n]) => n) : []
    // Deploying everything by leaving out an argument is not a thing.
    if (!names.length) {
      throw new KitError(
        'kit deploy needs at least one target',
        `Targets: ${Object.keys(config.targets).join(', ')}`,
        ExitCode.usage,
      )
    }
    if (ctx.args.comment && !ctx.args.preview) {
      throw new KitError(
        '--comment needs --preview',
        'kit deploy <target> --preview --comment',
        ExitCode.usage,
      )
    }
    if (config.cloudflare?.accountId) (await import('../lib/cloudflare')).pinCloudflareAccount(root, config)
    if (ctx.args.preview) {
      const { runPreview } = await import('./_preview')
      await runPreview(ctx, names, { env: ctx.args.env, comment: !!ctx.args.comment })
      return
    }
    const envs = envsFor(config, names, ctx.args.env)
    const self = [process.execPath, '--no-env-file', process.argv[1]!]
    const seen = new Set<string>()
    const deploys = names.map((name) => {
      const env = envs.get(name)
      const cmds = targetCommands(root, config, name, 'deploy', { env, extra: ctx.rest })
      if (!cmds) {
        throw new KitError(
          `Target "${name}" has no deploy command`,
          `Set targets.${name}.deploy in kit.config.ts`,
          ExitCode.usage,
        )
      }
      // A before step several targets share (`env sync`) runs once, ahead of the first.
      const before = beforeCommands(config, name)
        .filter((args) => {
          const key = args.join(' ')
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .map((args) => ({
          title: `kit ${args.join(' ')}`,
          cmd: [...self, ...args, ...(ctx.flags.yes ? ['--yes'] : [])],
        }))
      return { name, env, before, cmds }
    })

    if (ctx.flags.dryRun) {
      const plans = deploys.map((d) => ({
        target: d.name,
        env: d.env,
        plan: [...d.before.map((b) => b.title), ...d.cmds.map((c) => c.cmd.join(' '))],
      }))
      if (ctx.flags.json) emitJson({ dryRun: true, deploys: plans })
      else for (const p of plans) for (const step of p.plan) ctx.log.step(`${p.target}  ${step}`)
      return
    }

    // --json: children print to stderr and the one document comes last.
    const exec = ctx.flags.json ? runToStderr : run
    const results: DeployResult[] = []
    const started = performance.now()
    const since = (t: number) => Math.round(performance.now() - t)
    const report = () => {
      for (const r of results) r.ms = r.steps.reduce((sum, s) => sum + s.ms, 0)
      if (ctx.flags.json) emitJson({ ok: results.every((r) => r.ok), ms: since(started), deploys: results })
    }
    for (const [i, d] of deploys.entries()) {
      const result: DeployResult = { target: d.name, env: d.env, ok: false, ms: 0, steps: [] }
      results.push(result)
      const skipped = names.slice(i + 1)
      const and = skipped.length ? `; skipped ${skipped.join(', ')}` : ''
      for (const b of d.before) {
        ctx.log.step(b.title)
        const t = performance.now()
        const code = await exec(b.cmd, { cwd: root, env: { KIT_ROOT: root } })
        result.steps.push({ title: b.title, code, ms: since(t) })
        if (code !== 0) {
          report()
          throw new KitError(
            `${b.title} failed (exit ${code}); not deploying ${d.name}${and}`,
            undefined,
            ExitCode.precondition,
          )
        }
      }
      for (const c of d.cmds) {
        ctx.log.step(`${d.name}: ${c.title}`)
        const t = performance.now()
        const code = await exec(c.cmd, { cwd: c.cwd, env: c.env })
        result.steps.push({ title: c.title, code, ms: since(t) })
        if (code !== 0) {
          report()
          if (!ctx.flags.json) ctx.log.error(`deploy ${d.name} failed (exit ${code})${and}`)
          process.exitCode = ExitCode.failed
          return
        }
      }
      result.ok = true
      ctx.log.success(`deployed ${d.name}${d.env ? ` (${d.env})` : ''}`)
    }
    report()
  },
})
