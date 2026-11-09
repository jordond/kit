import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Install App Store signing with match (readonly); --add creates what is missing',
  group: 'Release',
  args: {
    add: {
      type: 'boolean',
      description:
        "Create missing certificates/profiles for this app's bundle ids and team only (never nuke)",
    },
  },
  examples: 'kit release certs\nkit release certs --add',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { appleCreds, onGitHubActions } = await import('../../lib/release/creds')
    const { appFastlaneDir, runLane } = await import('../../lib/fastlane')
    const { confirm } = await import('../../lib/prompt')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const ios = config.release?.ios
    if (!ios) throw new KitError('No release.ios in kit.config.ts', undefined, ExitCode.config)
    const mode = ctx.args.add ? 'add' : 'readonly'
    const plan = { mode, bundleIds: ios.bundleIds, teamId: ios.teamId ?? null }
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ ...plan, dryRun: true })
      else
        ctx.log.step(
          `match appstore (${mode}) for ${ios.bundleIds.join(', ')}${ios.teamId ? ` team ${ios.teamId}` : ''}`,
        )
      return
    }
    if (mode === 'add') {
      const ok = await confirm(
        ctx.flags,
        `Create missing App Store signing for ${ios.bundleIds.join(', ')} in the match repo? (existing certificates are reused, never revoked)`,
      )
      if (!ok) throw new KitError('Cancelled', undefined, ExitCode.interrupted)
    }
    const appRoot = appFastlaneDir(root, config)
    const env = {
      ...appleCreds({ match: true, ci: onGitHubActions() }).env,
      KIT_IOS_BUNDLE_IDS: ios.bundleIds.join(','),
      KIT_IOS_BUNDLE_ID: ios.bundleIds[0]!,
      ...(ios.teamId ? { KIT_IOS_TEAM_ID: ios.teamId } : {}),
      KIT_CERTS_MODE: mode,
    }
    const quiet = ctx.flags.json || ctx.flags.quiet
    const r = await runLane(appRoot, 'ios', 'certs', {
      env,
      onLine: quiet ? undefined : (l) => process.stderr.write(`${l}\n`),
    })
    if (ctx.flags.json) emitJson({ ...plan, ok: r.code === 0 })
    if (r.code !== 0) {
      if (quiet) process.stderr.write(`${r.output}\n`)
      throw new KitError(`match (${mode}) failed (exit ${r.code})`)
    }
    ctx.log.success(`signing ${mode === 'add' ? 'added' : 'installed'} for ${ios.bundleIds.join(', ')}`)
  },
})
