import pc from 'picocolors'
import type { KitContext } from '../../cli/command'
import { type KitConfig, type Track, tracks } from '../../config/schema'
import { interrupted } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { appFastlaneDir } from '../fastlane'
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
 *   preconditions → preflight + resolve build (tree) → confirm → promote lane → summary.
 * iOS resolves the build from the source tester group, so a build that never reached it is refused.
 * The build keeps the tag from its first release; a promotion never tags (HEAD did not build it).
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
  /** iOS: the version name of the build, when it predates a version bump; default: the TOML version. */
  version?: string
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
  /** The build's tag, `<platform>/v<version>+<build>`. A promotion never creates it. */
  tag?: string
  /** The tag is there (the build was tagged when it was first released). */
  tagExisted?: boolean
  /** When the tag is missing: the command to run on the commit the build was made from. */
  tagCommand?: string
}

const APP_STORE_WHATS_NEW_MAX = 4000
const VERSION = /^\d+\.\d+\.\d+$/

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

/**
 * Android: the highest version code on the source track, from the `status` lane's outputs. A track the
 * store would not answer for is not an empty track: its error is the message.
 */
export function playBuildToPromote(from: PromoteFrom, outputs: Record<string, string>): number {
  const track = parseStatus('android', outputs).find((t) => t.track === from)
  if (!track || track.state === 'unknown') {
    throw new KitError(
      `Could not read the Play ${from} track: ${track?.error ?? 'the status lane reported nothing'}`,
      'Check the Play service account, or pass --build <version code>',
    )
  }
  if (track.build === null) {
    throw new KitError(
      `No release on the Play ${from} track to promote`,
      `Release one first (kit release android --track ${from}), or pass --build`,
    )
  }
  return track.build
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
  if (opts.version !== undefined) {
    if (platform !== 'ios') {
      throw usage(
        '--app-version applies to iOS only: a Play release is found by its version code alone',
        'Pass --build <version code>',
      )
    }
    if (!VERSION.test(opts.version)) {
      throw usage(`--app-version must be MAJOR.MINOR.PATCH, got "${opts.version}"`)
    }
  }
  const version = opts.version ?? readVersion(root, config, platform)
  const appRoot = appFastlaneDir(root, config)
  const common: Record<string, string> = { ...storeCreds(platform), ...laneConfigEnv(root, config) }

  const lane = platform === 'android' ? 'promote' : to === 'prod' ? 'promote_appstore' : 'promote_testflight'
  // iOS: TestFlight tracks are tester groups. The build must be in the source group, which an internal
  // build (sent to no group) never is.
  const fromGroup = platform === 'ios' ? (ios!.testflightGroups?.[from] ?? from) : ''
  const groups = platform === 'ios' && to === 'beta' ? (ios!.testflightGroups?.beta ?? 'beta') : ''
  const lookup = platform === 'ios' ? 'promote_build' : 'status'
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
    // iOS always asks: --build is checked against the source group too.
    ...(platform === 'ios' || opts.build === undefined ? [`fastlane ${platform} ${lookup}`] : []),
    `fastlane ${platform} ${lane}`,
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

  // ---- preflight (+ Android: the version code to promote)
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
  if (platform === 'android' && build === undefined) {
    pre.push(
      laneStep(
        `version code on ${from}`,
        appRoot,
        'android',
        'status',
        () => ({ ...common, KIT_STATUS_TRACKS: from }),
        (o) => {
          build = playBuildToPromote(from, o)
        },
      ),
    )
  }
  if (pre.length) {
    const results = await withStdoutOnStderr(() =>
      runSteps([{ title: 'preflight', steps: pre }], flags, { bail: true }),
    )
    if (failed(results)) {
      const code = summarize('preflight', results, started)
      if (flags.json) emitJson({ ...result(), ok: false, stage: 'preflight', results })
      process.exitCode = code === 130 ? 130 : ExitCode.precondition
      return
    }
  }

  // ---- iOS: the build must be in the source tester group (the promote lanes check it again)
  const iosEnv = (): Record<string, string> => ({
    ...common,
    KIT_IOS_VERSION: version,
    KIT_TESTFLIGHT_FROM_GROUP: fromGroup,
    ...(build !== undefined ? { KIT_IOS_BUILD: String(build) } : {}),
  })
  if (platform === 'ios') {
    const steps = [
      laneStep(`build in TestFlight group "${fromGroup}"`, appRoot, 'ios', 'promote_build', iosEnv, (o) => {
        const n = Number(o.PROMOTE_BUILD)
        if (!Number.isInteger(n) || n <= 0) throw new KitError('fastlane ios promote_build reported no build')
        build = n
      }),
    ]
    const results = await runSteps([{ title: 'resolve', steps }], flags, { bail: true })
    if (failed(results) || results.length !== steps.length || interrupted()) {
      if (flags.json) emitJson({ ...result(), ok: false, stage: 'resolve', results })
      process.exitCode = summarize(
        'promote ios',
        results,
        started,
        `Only a build released to "${fromGroup}" can be promoted: kit release ios --track ${from}`,
      )
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
          ...iosEnv(),
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

  // ---- tag: a tag names a build, so the one from its first release stands. kit never creates it here:
  // HEAD is not the commit that built this build.
  const name = mobileTag(platform, version, build)
  out.tag = name
  out.tagExisted = await tagExists(root, name)
  if (!out.tagExisted) {
    out.tagCommand = `git tag -a ${name} -m "${platform} ${version} (${build})" <commit> && git push origin ${name}`
    const msg = `promoted, but there is no ${name} tag, and kit does not create it here: HEAD is not the commit that built this build`
    ctx.log.warn(msg)
    if (onGitHubActions()) process.stderr.write(`::warning title=kit release::${msg}\n`)
    ctx.log.dim(`  › on the commit the build was made from: ${out.tagCommand}`)
  }

  if (flags.json) emitJson({ ...out, ok: true })
  summarize(`promote ${platform}`, results, started)
  if (!flags.json && out.tagExisted) ctx.log.dim(`  tag: ${name}`)
}
