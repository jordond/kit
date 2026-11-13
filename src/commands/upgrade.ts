import { defineCommand } from '../cli/command'

/**
 * `kit upgrade [version]`: move the repo to another kit release in one step. The npm pin
 * (`package.json`, or `.kit/package.json`) gets the new version, the install runs, and every
 * `jordond/kit/…@<sha> # vX.Y.Z` in `.github/workflows` moves to that release's tag commit, so
 * `kit doctor --ci` keeps passing. Re-running is safe: it also repairs workflow pins that lag
 * the npm pin.
 */
export default defineCommand({
  description: 'Move the @jordond/kit pin and the workflow SHAs to a kit release',
  group: 'Setup',
  examples: [
    'kit upgrade           # the latest release on npm',
    'kit upgrade 0.6.0',
    'kit upgrade --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { existsSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { installDir } = await import('../config/load')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { bumpPin, isVersion, KIT_PACKAGE, latestVersion, repinWorkflow, tagSha } =
      await import('../lib/kitref')
    const { emitJson } = await import('../lib/log')
    const { detectPackageManager } = await import('../lib/pm')
    const { run, runQuiet } = await import('../lib/proc')

    const root = ctx.root ?? process.cwd()
    const dir = installDir(root)
    const manifest = join(dir, 'package.json')
    if (!existsSync(join(root, manifest))) {
      throw new KitError(`No ${manifest} here`, 'Run it in a repo that uses kit', ExitCode.config)
    }
    const asked = ctx.positionals[0]?.replace(/^v/, '')
    if (asked !== undefined && !isVersion(asked)) {
      throw new KitError(`"${ctx.positionals[0]}" is not a version`, 'Pass X.Y.Z', ExitCode.usage)
    }
    const version = asked ?? (await latestVersion())
    if (!version) {
      throw new KitError(
        `Could not read the latest ${KIT_PACKAGE} version from npm`,
        'Pass it: kit upgrade X.Y.Z',
      )
    }
    const before = readFileSync(join(root, manifest), 'utf8')
    const pin = bumpPin(before, version)
    if (!pin) {
      throw new KitError(`${manifest} does not depend on ${KIT_PACKAGE}`, undefined, ExitCode.config)
    }
    if (pin.to === pin.from && !pin.from.endsWith(version)) {
      throw new KitError(
        `${manifest} pins ${KIT_PACKAGE} to "${pin.from}", which is not a version range`,
        'Edit it by hand',
        ExitCode.config,
      )
    }

    const sha = await tagSha(version)
    const wfDir = join(root, '.github/workflows')
    const workflows = (existsSync(wfDir) ? readdirSync(wfDir) : [])
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
      .map((f) => {
        const file = join('.github/workflows', f)
        const text = readFileSync(join(root, file), 'utf8')
        // Without the SHA nothing is rewritten; a probe ref still counts the pins that would move.
        const next = repinWorkflow(text, version, sha ?? '0'.repeat(40))
        return { file, text: next.text, pins: next.count }
      })
      .filter((w) => w.pins > 0)
    const pinChanged = pin.text !== before
    const say = !ctx.flags.json
    const doc = {
      from: pin.from,
      to: pin.to,
      manifest,
      sha: sha ?? null,
      workflows: workflows.map(({ file, pins }) => ({ file, pins })),
    }

    if (say) {
      if (pinChanged) ctx.log.step(`${manifest}: ${KIT_PACKAGE} ${pin.from} → ${pin.to}`)
      else ctx.log.dim(`- ${manifest}  already ${pin.from}`)
      for (const w of workflows)
        ctx.log.step(`${w.file}: ${w.pins} pin${w.pins === 1 ? '' : 's'} → v${version}`)
    }
    const unresolved = workflows.length > 0 && !sha
    const noSha = () => {
      ctx.log.error(
        `v${version} not found in the kit repo: workflow pins left as they are`,
        `Re-run \`kit upgrade ${version}\` once the tag exists; \`kit doctor --ci\` fails until then`,
      )
    }
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ ok: !unresolved, ...doc })
      else if (unresolved) noSha()
      if (unresolved) process.exitCode = 1
      return
    }

    let ok = true
    if (pinChanged) {
      writeFileSync(join(root, manifest), pin.text)
      const cwd = join(root, dir)
      const cmd = [detectPackageManager(cwd, root), 'install']
      if (say) ctx.log.step(`${cmd.join(' ')}${dir === '.' ? '' : ` (${dir})`}`)
      const code = ctx.flags.json ? (await runQuiet(cmd, { cwd })).code : await run(cmd, { cwd })
      if (code !== 0) {
        // Nothing half-moved: the pin goes back and the workflows stay.
        writeFileSync(join(root, manifest), before)
        if (say) ctx.log.error(`${cmd.join(' ')} failed (exit ${code}): ${manifest} restored`)
        if (ctx.flags.json) emitJson({ ok: false, ...doc })
        process.exitCode = 1
        return
      }
    }
    if (sha) for (const w of workflows) writeFileSync(join(root, w.file), w.text)
    else if (unresolved) {
      ok = false
      if (say) noSha()
    }
    if (ctx.flags.json) emitJson({ ok, ...doc })
    else if (ok)
      ctx.log.success(pinChanged || workflows.length ? `kit ${version}` : `already on kit ${version}`)
    if (!ok) process.exitCode = 1
  },
})
