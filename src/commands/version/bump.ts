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
    const {
      bumpLevels,
      expandPlatforms,
      iosVersionDrift,
      nextVersion,
      readVersion,
      readXcconfig,
      setVersion,
      setXcconfigVersion,
    } = await import('../../lib/release/version')
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
    // iOS: keep release.ios.xcconfig's MARKETING_VERSION equal to the TOML, in the same commit.
    const iosChange = changes.find((c) => c.name === 'ios')
    const xcconfig = iosChange ? config.release?.ios?.xcconfig : undefined
    if (xcconfig) {
      const drift = iosVersionDrift(root, config)
      if (drift) {
        throw new KitError(
          `iOS version drift before the bump: ${file} says ${drift.toml}, ${xcconfig} says ${drift.xcconfig ?? '(no MARKETING_VERSION)'}`,
          'Make them equal (the TOML is the source), commit, then bump',
          ExitCode.precondition,
        )
      }
    }
    const subject = `chore(release): ${changes.map((c) => `${c.name} ${c.to}`).join(', ')}`
    const json = (extra: Record<string, unknown>) => {
      if (ctx.flags.json)
        emitJson({ file, ...(xcconfig ? { xcconfig } : {}), changes, commit: subject, ...extra })
    }
    if (ctx.flags.dryRun) {
      json({ dryRun: true })
      if (!ctx.flags.json) {
        for (const c of changes) ctx.log.step(`${c.name}: ${c.from} → ${c.to}`)
        if (xcconfig) ctx.log.step(`${xcconfig}: MARKETING_VERSION → ${iosChange!.to}`)
        ctx.log.dim(
          `  commit "${subject}"${ctx.args['no-push'] ? '' : ctx.args.pr ? ', push a branch and open a PR' : ', push'}`,
        )
      }
      return
    }

    await checkClean(root)
    const base = await checkBranch(root, config)
    // Ask before touching anything: a refusal (no terminal) must not leave a commit behind that a
    // re-run would bump again.
    const pushIt =
      !ctx.args['no-push'] &&
      (ctx.args.pr ||
        (await confirm(ctx.flags, `Commit and push the bump to origin/${base}?`, { initial: true })))
    const git = async (...args: string[]) => {
      const r = await runPiped(['git', ...args], { cwd: root })
      if (r.code !== 0) throw new ProcError(['git', ...args], r.code, `${r.stdout}${r.stderr}`)
      return r.stdout.trim()
    }

    // Compute every edit before writing any, and check the xcconfig is tracked (a gitignored one
    // can't be committed), so a failure leaves the tree as it was.
    const path = join(root, file)
    const tomlBefore = readFileSync(path, 'utf8')
    let tomlAfter = tomlBefore
    for (const c of changes) tomlAfter = setVersion(tomlAfter, config, c.name, c.to)
    const edits = [{ rel: file, path, before: tomlBefore, after: tomlAfter }]
    if (xcconfig) {
      const r = await runPiped(['git', 'ls-files', '--error-unmatch', '--', xcconfig], { cwd: root })
      if (r.code !== 0) {
        throw new KitError(
          `${xcconfig} (release.ios.xcconfig) is not tracked by git`,
          'Commit it first; kit commits the bump to it with the TOML',
          ExitCode.precondition,
        )
      }
      const before = readXcconfig(root, xcconfig)
      edits.push({
        rel: xcconfig,
        path: join(root, xcconfig),
        before,
        after: setXcconfigVersion(before, xcconfig, iosChange!.to),
      })
    }

    let branch = base
    if (ctx.args.pr) {
      branch = `chore/bump-${changes.map((c) => `${c.name}-${c.to}`).join('-')}`
      await git('switch', '-c', branch)
    }
    try {
      for (const e of edits) writeFileSync(e.path, e.after)
      await git('commit', '-m', subject, '--', ...edits.map((e) => e.rel))
    } catch (err) {
      for (const e of edits) writeFileSync(e.path, e.before)
      if (ctx.args.pr) {
        await runPiped(['git', 'switch', base], { cwd: root })
        await runPiped(['git', 'branch', '-D', branch], { cwd: root })
      }
      throw err
    }
    const sha = await git('rev-parse', '--short', 'HEAD')
    for (const c of changes) ctx.log.success(`${c.name} ${c.from} → ${c.to}`)
    ctx.log.dim(`  committed ${sha} on ${branch}: ${subject}`)

    if (!pushIt) {
      json({ sha, branch, pushed: false })
      if (!ctx.args['no-push']) ctx.log.dim(`  not pushed; run \`git push origin ${branch}\``)
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
