import type { Args } from 'gunshi'
import { defineCommand, type KitCommand } from '../../cli/command'

/** Split a config command: `kit …` runs this kit (same binary), anything else runs under sh. */
export function serviceCmd(command: string): string[] {
  const t = command.trim()
  if (t === 'kit' || t.startsWith('kit ')) {
    return [
      process.execPath,
      '--no-env-file',
      process.argv[1]!,
      ...t.slice(3).trim().split(/\s+/).filter(Boolean),
    ]
  }
  return ['sh', '-c', t]
}

/** `kit release <service>`: build, deploy, then tag `{service}/v{version}` (PLAN §9.2). */
export function serviceCommand(name: string): KitCommand<Args> {
  return defineCommand({
    description: `Release the ${name} service (build, deploy, tag ${name}/v<version>)`,
    group: 'Release',
    examples: `kit release ${name}\nkit release ${name} --dry-run`,
    async run(ctx) {
      const { requireProject } = await import('../../cli/command')
      const { ExitCode, KitError } = await import('../../lib/errors')
      const { checkBranch, checkClean } = await import('../../lib/release/mobile')
      const { readVersion } = await import('../../lib/release/version')
      const { serviceTag } = await import('../../lib/release/notes')
      const { push, tag } = await import('../../lib/git')
      const { runPiped } = await import('../../lib/proc')
      const { confirm } = await import('../../lib/prompt')
      const { commandStep, runSteps, summarize } = await import('../../lib/steps')
      const { emitJson } = await import('../../lib/log')
      const started = performance.now()
      const { root, config } = requireProject(ctx)
      const svc = config.release?.services?.[name]
      if (!svc) throw new KitError(`No release.services.${name}`, undefined, ExitCode.config)
      const version = readVersion(root, config, svc.versionKey)
      const tagName = serviceTag(name, version)
      const plan = [
        ...(svc.build ? [svc.build] : []),
        svc.deploy,
        `git tag ${tagName} && git push origin ${tagName}`,
      ]
      if (ctx.flags.dryRun) {
        if (ctx.flags.json) emitJson({ service: name, version, tag: tagName, plan, dryRun: true })
        else for (const p of plan) ctx.log.step(p)
        return
      }
      await checkClean(root)
      await checkBranch(root, config)
      const exists = await runPiped(['git', 'rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`], {
        cwd: root,
      })
      if (exists.code === 0) {
        throw new KitError(
          `${tagName} already exists`,
          `Bump first: kit version bump patch --platform ${svc.versionKey}`,
          ExitCode.precondition,
        )
      }
      if (!(await confirm(ctx.flags, `Release ${name} ${version} (${plan.slice(0, -1).join(' → ')})?`))) {
        throw new KitError('Cancelled', undefined, ExitCode.interrupted)
      }
      const env = { KIT_ROOT: root }
      const steps = [
        ...(svc.build ? [commandStep('build', serviceCmd(svc.build), { cwd: root, env })] : []),
        commandStep('deploy', serviceCmd(svc.deploy), { cwd: root, env }),
      ]
      const results = await runSteps([{ title: name, steps }], ctx.flags, { bail: true })
      if (results.some((r) => !r.ok)) {
        if (ctx.flags.json) emitJson({ service: name, version, ok: false, results })
        process.exitCode = summarize(`release ${name}`, results, started)
        return
      }
      let tagPushed = false
      try {
        await tag(tagName, { cwd: root, message: `${name} ${version}` })
        await push([`refs/tags/${tagName}`], { cwd: root })
        tagPushed = true
      } catch (e) {
        ctx.log.warn(`deployed, but tagging ${tagName} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (ctx.flags.json) emitJson({ service: name, version, ok: true, tag: tagName, tagPushed })
      summarize(`release ${name}`, results, started)
    },
  }) as KitCommand<Args>
}
