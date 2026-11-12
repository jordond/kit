import pc from 'picocolors'
import type { KitContext } from '../../cli/command'
import { type KitConfig, type Track, tracks } from '../../config/schema'
import { interrupted } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { appFastlaneDir } from '../fastlane'
import { push, tag } from '../git'
import { emitJson, withStdoutOnStderr } from '../log'
import { runPiped } from '../proc'
import { runSteps, type Step, type StepResult, summarize } from '../steps'
import { onGitHubActions } from './creds'
import { checkBranch, confirmTrack, laneConfigEnv, laneStep, type Platform } from './mobile'
import { clampNotes, mobileTag, PLAY_NOTES_MAX } from './notes'
import { loadPreflights } from './preflight'
import { parseStatus, requireBundle, requirePlatformConfig, storeCreds } from './status'
import { readVersion } from './version'

/**
 * `kit release promote <ios|android> --from <alpha|beta> --to <beta|prod>`: move a build the store
 * already has to a later track. Nothing is built or uploaded.
 *   preconditions → preflight + resolve build (tree) → confirm → promote lane → tag → summary.
 * Internal builds are never promoted: they are compiled with KIT_INTERNAL set (see `internalFlag` in
 * mobile.ts), so a later track needs a rebuild.
 */

export type PromoteFrom = 'alpha' | 'beta'
export type PromoteTo = 'beta' | 'prod'

export interface PromoteOptions {
  platform: Platform
  from: PromoteFrom
  to: PromoteTo
  /** Build number (iOS) or version code (Android); default: the latest on the source track. */
  build?: number
  /** Android prod staged-rollout fraction. */
  rollout?: number
  notes?: string
  /** Android: promote as a draft release. */
  draft?: boolean
  /** `--skip` values: preflight skipFlags. */
  skip: string[]
}

export interface PromoteResult {
  platform: Platform
  from: PromoteFrom
  to: PromoteTo
  version: string
  /** null in a dry run without --build: the store is not asked. */
  build: number | null
  dryRun: boolean
  promoted: boolean
  /** The lanes and git commands, in order. */
  plan: string[]
  tag?: string
  tagPushed?: boolean
  /** The tag was already there (the build was tagged when it was first released). */
  tagExisted?: boolean
}

const APP_STORE_WHATS_NEW_MAX = 4000

const usage = (message: string, hint?: string) => new KitError(message, hint, ExitCode.usage)

/** `--from` / `--to` as given on the command line → a promotion kit allows, or exit 2. */
export function validatePromotion(
  from: string | undefined,
  to: string | undefined,
): { from: PromoteFrom; to: PromoteTo } {
  if (!from || !to) throw usage('kit release promote needs --from <alpha|beta> and --to <beta|prod>')
  if (from === 'internal') {
    throw usage(
      'Internal builds are never promoted: they are compiled with KIT_INTERNAL set (BuildConstants.IS_INTERNAL), and a promoted build keeps it',
      `Rebuild for the later track: kit release <platform> --track ${(tracks as readonly string[]).includes(to) && to !== 'internal' ? to : '<track>'}`,
    )
  }
  if (from !== 'alpha' && from !== 'beta') throw usage(`--from must be alpha or beta, got "${from}"`)
  if (to !== 'beta' && to !== 'prod') throw usage(`--to must be beta or prod, got "${to}"`)
  if (tracks.indexOf(to) <= tracks.indexOf(from)) {
    throw usage(
      `--to must be a later track than --from: ${from} → ${to} is not a promotion`,
      `Tracks in order: ${tracks.join(' → ')}`,
    )
  }
  return { from, to }
}

/** The latest build on the source track, from the `status` lane's outputs. */
export function buildToPromote(
  platform: Platform,
  from: PromoteFrom,
  outputs: Record<string, string>,
): number | undefined {
  // TestFlight keeps one build list: tester groups are not tracks the API can be asked about.
  const track = platform === 'ios' ? 'testflight' : from
  return parseStatus(platform, outputs).find((t) => t.track === track)?.build ?? undefined
}

const failed = (results: StepResult[]) => results.some((r) => !r.ok)

async function tagExists(root: string, name: string): Promise<boolean> {
  return (
    (await runPiped(['git', 'rev-parse', '-q', '--verify', `refs/tags/${name}`], { cwd: root })).code === 0
  )
}

export async function promoteMobile(
  ctx: Pick<KitContext, 'root' | 'config' | 'flags' | 'log'>,
  opts: PromoteOptions,
): Promise<void> {
  const started = performance.now()
  const { root, config } = ctx as { root: string; config: KitConfig }
  const { platform, from, to } = opts
  const flags = ctx.flags
  const ios = config.release?.ios
  const android = config.release?.android
  requirePlatformConfig(config, platform)

  // ---- preconditions
  let notes = opts.notes?.trim() || undefined
  if (platform === 'ios' && to === 'prod' && !flags.dryRun) {
    if (!notes) {
      throw usage(
        '--to prod needs --notes "<What\'s New>"',
        'App Store Connect rejects an update without it, and users read it',
      )
    }
    if (notes.length > APP_STORE_WHATS_NEW_MAX) {
      throw new KitError(`--notes is ${notes.length} chars; the App Store allows ${APP_STORE_WHATS_NEW_MAX}`)
    }
  }
  if (opts.rollout !== undefined && (platform !== 'android' || to !== 'prod')) {
    throw usage(
      '--rollout applies to Android production only',
      platform === 'ios' ? 'The App Store uses a phased release; see `kit release rollout ios`' : undefined,
    )
  }
  if (opts.draft && platform !== 'android') throw usage('--draft applies to Android only')
  const rollout = opts.rollout ?? android?.prodRollout ?? 0.1
  if (!(rollout > 0 && rollout <= 1)) throw usage(`--rollout must be in (0, 1], got ${rollout}`)
  if (opts.build !== undefined && !(Number.isInteger(opts.build) && opts.build > 0)) {
    throw usage(`--build must be a positive integer, got ${opts.build}`)
  }
  if (platform === 'android' && notes) {
    if (to === 'prod') {
      ctx.log.warn('--notes ignored: Play production "What\'s new" is managed in the Play Console')
      notes = undefined
    } else {
      notes = clampNotes(notes, config.release?.notes?.maxLength ?? PLAY_NOTES_MAX)
    }
  }
  requireBundle()
  const branch = await checkBranch(root, config)
  const version = readVersion(root, config, platform)
  const appRoot = appFastlaneDir(root, config)
  const common: Record<string, string> = { ...storeCreds(platform), ...laneConfigEnv(root, config) }

  const lane = platform === 'android' ? 'promote' : to === 'prod' ? 'promote_appstore' : 'promote_testflight'
  const groups = platform === 'ios' && to === 'beta' ? (ios!.testflightGroups?.beta ?? 'beta') : ''
  const where =
    platform === 'ios'
      ? to === 'prod'
        ? 'App Store (phased, manual release)'
        : `TestFlight group "${groups}"`
      : `Play ${to === 'prod' ? `production (rollout ${rollout})` : to}${opts.draft ? ' as draft' : ''}`
  let build = opts.build
  const describe = () =>
    `${config.name} ${platform} ${version} (${build ?? `latest on ${from}`}): ${from} → ${where}`
  const plan = () => [
    ...(opts.build === undefined ? [`fastlane ${platform} status`] : []),
    `fastlane ${platform} ${lane}`,
    `git tag ${mobileTag(platform, version, build ?? '<build>')} (unless it exists) && git push origin <tag>`,
  ]
  const result = (): PromoteResult => ({
    platform,
    from,
    to,
    version,
    build: build ?? null,
    dryRun: flags.dryRun,
    promoted: false,
    plan: plan(),
  })

  // ---- dry run: the plan, and nothing else
  if (flags.dryRun) {
    if (flags.json) emitJson({ ...result(), ok: true })
    else {
      process.stderr.write(
        `\n${pc.bold(describe())}${pc.yellow('  [dry run: nothing runs]')}\n${pc.dim(`branch ${branch}`)}\n\n`,
      )
      for (const p of plan()) ctx.log.step(p)
    }
    return
  }

  // ---- preflight + resolve
  const pre: Step[] = []
  for (const p of (await loadPreflights(root, config)).filter(
    (x) => !x.platforms || x.platforms.includes(platform),
  )) {
    if (p.skipFlag && opts.skip.includes(p.skipFlag)) {
      ctx.log.warn(`skipped preflight: ${p.title} (--skip ${p.skipFlag})`)
      continue
    }
    pre.push({
      title: p.title,
      task: () => p.check({ root, config, flags, log: ctx.log }, { platform, track: to as Track, version }),
    })
  }
  if (build === undefined) {
    pre.push(
      laneStep(
        `latest ${platform === 'ios' ? 'TestFlight build' : `version code on ${from}`}`,
        appRoot,
        platform,
        'status',
        () => ({
          ...common,
          ...(platform === 'ios' ? { KIT_IOS_VERSION: version } : { KIT_STATUS_TRACKS: from }),
        }),
        (o) => {
          build = buildToPromote(platform, from, o)
          if (build === undefined) {
            throw new KitError(
              platform === 'ios'
                ? `No TestFlight build of ${version} to promote`
                : `No release on the Play ${from} track to promote`,
              `Release one first (kit release ${platform} --track ${from}), or pass --build`,
            )
          }
        },
      ),
    )
  }
  if (pre.length) {
    const results = await withStdoutOnStderr(() =>
      runSteps([{ title: 'preflight', steps: pre }], flags, { bail: true }),
    )
    if (failed(results)) {
      const code = summarize('preflight', results, started, 'Pass --build to skip the store lookup')
      if (flags.json) emitJson({ ...result(), ok: false, stage: 'preflight', results })
      process.exitCode = code === 130 ? 130 : ExitCode.precondition
      return
    }
  }
  if (build === undefined) throw new KitError('No build number resolved')

  // ---- confirm
  const summary = describe()
  if (!flags.json) {
    process.stderr.write(
      `\n${pc.bold(summary)}\n${pc.dim(`branch ${branch}`)}\n${notes ? `${pc.dim(notes.replace(/^/gm, '  '))}\n` : ''}\n`,
    )
  }
  if (!(await confirmTrack(flags, to, summary))) {
    throw new KitError('Promotion cancelled', undefined, ExitCode.interrupted)
  }

  // ---- promote
  const env = (): Record<string, string> =>
    platform === 'android'
      ? {
          ...common,
          KIT_PLAY_TRACK: from,
          KIT_PLAY_PROMOTE_TO: to,
          KIT_ANDROID_CODE: String(build),
          ...(to === 'prod' && !opts.draft ? { KIT_PLAY_ROLLOUT: String(rollout) } : {}),
          ...(opts.draft ? { KIT_PLAY_DRAFT: '1' } : {}),
          ...(notes ? { KIT_RELEASE_NOTES: notes } : {}),
        }
      : {
          ...common,
          KIT_IOS_VERSION: version,
          KIT_IOS_BUILD: String(build),
          ...(to === 'beta' ? { KIT_TESTFLIGHT_GROUPS: groups } : {}),
          ...(notes ? { KIT_RELEASE_NOTES: notes } : {}),
        }
  const steps = [laneStep(`promote ${from} → ${to}`, appRoot, platform, lane, env)]
  const results = await runSteps([{ title: `${platform} promote`, steps }], flags, { bail: true })
  const out = result()
  if (failed(results) || results.length !== steps.length || interrupted()) {
    if (flags.json) emitJson({ ...out, ok: false, results })
    process.exitCode = summarize(`promote ${platform}`, results, started)
    return
  }
  out.promoted = true

  // ---- tag (the existing scheme has no track in it, so a build tagged at its first release keeps that tag)
  const name = mobileTag(platform, version, build)
  out.tag = name
  if (await tagExists(root, name)) {
    out.tagExisted = true
  } else {
    out.tagExisted = false
    try {
      await tag(name, { cwd: root, message: `${platform} ${version} (${build}) → ${to}` })
      await push([`refs/tags/${name}`], { cwd: root })
      out.tagPushed = true
    } catch (e) {
      out.tagPushed = false
      const msg = `promoted, but tagging ${name} failed: ${e instanceof Error ? e.message : String(e)}`
      ctx.log.warn(msg)
      if (onGitHubActions())
        process.stderr.write(`::warning title=kit release::${msg.replace(/\r?\n/g, ' ')}\n`)
      ctx.log.dim(`  › git tag -a ${name} -m "${platform} ${version} (${build})" && git push origin ${name}`)
    }
  }

  if (flags.json) emitJson({ ...out, ok: true })
  summarize(`promote ${platform}`, results, started)
  if (!flags.json) {
    ctx.log.dim(`  tag: ${name}${out.tagExisted ? ' (already there)' : out.tagPushed ? '' : ' (not pushed)'}`)
  }
}
