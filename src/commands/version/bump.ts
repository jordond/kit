import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Bump a version name in the catalog TOML, commit, and push',
  group: 'Release',
  args: {
    platform: {
      type: 'string',
      short: 'p',
      default: 'all',
      description: 'ios | android | all (ios + android) | a service key from versions.keys',
    },
    'no-push': { type: 'boolean', description: 'Commit only; do not push' },
    pr: { type: 'boolean', description: 'Commit on a new branch, push it and open a PR (gh)' },
  },
  examples:
    'kit version bump patch\nkit version bump minor --platform ios\nkit version bump patch --platform api --no-push\nkit version bump minor --pr',
  async run(ctx) {
    const { readFileSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { bumpLevels, expandPlatforms, nextVersion, readVersion, setVersion } = await import(
      '../../lib/release/version'
    )
    const { checkBranch, checkClean } = await import('../../lib/release/mobile')
    const { push } = await import('../../lib/git')
    const { ProcError, runPiped } = await import('../../lib/proc')
    const { confirm } = await import('../../lib/prompt')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)

    const level = ctx.positionals[0]
    if (!level || !(bumpLevels as readonly string[]).includes(level)) {
      throw new KitError(
        `kit version bump needs one of ${bumpLevels.join(' | ')}${level ? ` (got "${level}")` : ''}`,
        'kit version bump patch --platform ios',
        ExitCode.usage,
      )
    }
    if (ctx.args.pr && ctx.args['no-push']) {
      throw new KitError('--pr and --no-push conflict', undefined, ExitCode.usage)
    }
    const names = expandPlatforms(config, ctx.args.platform ?? 'all')
    const changes = names.map((name) => {
      const from = readVersion(root, config, name)
      return { name, from, to: nextVersion(from, level as 'patch') }
    })
    const file = config.versions!.file
    const subject = `chore(release): ${changes.map((c) => `${c.name} ${c.to}`).join(', ')}`
    const json = (extra: Record<string, unknown>) => {
      if (ctx.flags.json) emitJson({ file, changes, commit: subject, ...extra })
    }
    if (ctx.flags.dryRun) {
      json({ dryRun: true })
      if (!ctx.flags.json) {
        for (const c of changes) ctx.log.step(`${c.name}: ${c.from} → ${c.to}`)
        ctx.log.dim(
          `  commit "${subject}"${ctx.args['no-push'] ? '' : ctx.args.pr ? ', push a branch and open a PR' : ', push'}`,
        )
      }
      return
    }

    await checkClean(root)
    const base = await checkBranch(root, config)
    const git = async (...args: string[]) => {
      const r = await runPiped(['git', ...args], { cwd: root })
      if (r.code !== 0) throw new ProcError(['git', ...args], r.code, `${r.stdout}${r.stderr}`)
      return r.stdout.trim()
    }

    let branch = base
    if (ctx.args.pr) {
      branch = `chore/bump-${changes.map((c) => `${c.name}-${c.to}`).join('-')}`
      await git('switch', '-c', branch)
    }
    const path = join(root, file)
    let text = readFileSync(path, 'utf8')
    for (const c of changes) text = setVersion(text, config, c.name, c.to)
    writeFileSync(path, text)
    await git('commit', '-m', subject, '--', file)
    const sha = await git('rev-parse', '--short', 'HEAD')
    for (const c of changes) ctx.log.success(`${c.name} ${c.from} → ${c.to}`)
    ctx.log.dim(`  committed ${sha} on ${branch}: ${subject}`)

    if (ctx.args['no-push']) {
      json({ sha, branch, pushed: false })
      return
    }
    if (!ctx.args.pr && !(await confirm(ctx.flags, `Push ${branch} to origin?`, { initial: true }))) {
      json({ sha, branch, pushed: false })
      ctx.log.dim(`  not pushed; run \`git push origin ${branch}\``)
      return
    }
    try {
      await push([branch], { cwd: root })
    } catch (e) {
      json({ sha, branch, pushed: false })
      throw new KitError(
        `Push to origin/${branch} was rejected${e instanceof ProcError && e.output ? `:\n${e.output.trim()}` : ''}`,
        ctx.args.pr
          ? undefined
          : `The commit is local. If ${branch} is protected: git reset --hard HEAD~1 && kit version bump ${level} --platform ${ctx.args.platform} --pr`,
        ExitCode.failed,
      )
    }
    let pr: string | undefined
    if (ctx.args.pr) {
      const r = await runPiped(['gh', 'pr', 'create', '--fill', '--base', base, '--head', branch], {
        cwd: root,
      })
      await git('switch', base)
      if (r.code !== 0) {
        throw new KitError(
          `gh pr create failed (exit ${r.code}): ${r.stderr.trim()}`,
          `Branch ${branch} is pushed; open the PR by hand`,
        )
      }
      pr = r.stdout.trim().split('\n').pop()
    }
    json({ sha, branch, pushed: true, ...(pr ? { pr } : {}) })
    ctx.log.success(ctx.args.pr ? `opened ${pr} (${branch} → ${base})` : `pushed ${branch}`)
  },
})
