import pc from 'picocolors'
import type { Flags, KitContext } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import { interrupted } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { appFastlaneDir } from '../fastlane'
import { emitJson } from '../log'
import { confirm, text } from '../prompt'
import { runSteps, summarize } from '../steps'
import { onGitHubActions } from './creds'
import { laneConfigEnv, laneStep, type Platform } from './mobile'
import { requireBundle, requirePlatformConfig, storeCreds } from './status'

/**
 * `kit release rollout <ios|android>`: change the production rollout of what is already released.
 * - Android: the production track's staged rollout (fraction, halt, resume, complete).
 * - iOS: the live version's phased release. Apple fixes its 7-day schedule, so there is no percentage:
 *   it can only be paused (`--halt`), resumed or completed.
 */

export type RolloutAction = 'percent' | 'halt' | 'resume' | 'complete'

export interface RolloutArgs {
  percent?: number
  halt?: boolean
  resume?: boolean
  complete?: boolean
  /** Android: the version code of the release to change, when the track holds more than one. */
  build?: number
}

export interface RolloutPlan {
  action: RolloutAction
  /** `--percent` as given (1-100). */
  percent?: number
  /** `--percent` as the Play user fraction (0.01-1). */
  fraction?: number
  /** `--build`: the Android version code of the release to change. */
  build?: number
}

const usage = (message: string, hint?: string) => new KitError(message, hint, ExitCode.usage)

/** Exactly one action flag, valid for the platform, or exit 2. */
export function rolloutPlan(platform: Platform, args: RolloutArgs): RolloutPlan {
  const given: RolloutAction[] = [
    ...(args.percent !== undefined ? (['percent'] as const) : []),
    ...(args.halt ? (['halt'] as const) : []),
    ...(args.resume ? (['resume'] as const) : []),
    ...(args.complete ? (['complete'] as const) : []),
  ]
  if (platform === 'ios' && args.percent !== undefined) {
    throw usage(
      "--percent is Android only: the App Store has no rollout percentage (a phased release follows Apple's fixed 7-day schedule)",
      'Use --halt, --resume or --complete',
    )
  }
  const flags =
    platform === 'ios' ? '--halt, --resume, --complete' : '--percent, --halt, --resume, --complete'
  if (given.length !== 1) {
    throw usage(
      `kit release rollout ${platform} needs exactly one of ${flags}${given.length ? ` (got ${given.map((g) => `--${g}`).join(', ')})` : ''}`,
    )
  }
  if (args.build !== undefined) {
    if (platform === 'ios') {
      throw usage('--build is Android only: the App Store phased release belongs to the one live version')
    }
    if (!(Number.isInteger(args.build) && args.build > 0)) {
      throw usage(`--build must be a positive integer, got ${args.build}`)
    }
  }
  const build = args.build === undefined ? {} : { build: args.build }
  const action = given[0]!
  if (action !== 'percent') return { action, ...build }
  const percent = args.percent!
  if (!(Number.isFinite(percent) && percent >= 1 && percent <= 100)) {
    throw usage(`--percent must be between 1 and 100, got ${percent}`)
  }
  return { action, percent, fraction: Number((percent / 100).toFixed(4)), ...build }
}

/** What the action does, for the confirmation and the plan. */
export function describeRollout(platform: Platform, plan: RolloutPlan): string {
  if (platform === 'ios') {
    const verb = { halt: 'pause', resume: 'resume', complete: 'complete', percent: 'change' }[plan.action]
    return `${verb} the App Store phased release`
  }
  switch (plan.action) {
    case 'percent':
      return plan.fraction === 1
        ? 'complete the Play production rollout (100%)'
        : `set the Play production rollout to ${plan.percent}%`
    case 'halt':
      return 'halt the Play production rollout'
    case 'resume':
      return 'resume the Play production rollout'
    case 'complete':
      return 'complete the Play production rollout (100%)'
  }
}

/** `--halt` narrows production exposure; every other action widens it. */
export const widensExposure = (action: RolloutAction): boolean => action !== 'halt'

/**
 * PLAN §9.1. Widening production exposure (`--percent`, `--resume`, `--complete`) uses the prod release
 * gate: type "prod" locally (`--yes` does not skip it); on GitHub Actions the `production` environment's
 * reviewers answer it. `--halt` is the emergency brake: a plain confirmation that `--yes` skips.
 */
async function confirmRollout(flags: Flags, action: RolloutAction, summary: string): Promise<boolean> {
  if (!widensExposure(action)) return confirm(flags, `${summary}?`)
  // Only GITHUB_ACTIONS counts: CI=true can come from a shell or the root .env.
  if (onGitHubActions()) return true
  const typed = await text({ ...flags, yes: false }, `Type "prod" to ${summary}`, {
    hint: 'Widening a production rollout needs a terminal (or CI with the production environment); --yes does not skip it',
  })
  return typed.trim() === 'prod'
}

export async function rolloutMobile(
  ctx: Pick<KitContext, 'root' | 'config' | 'flags' | 'log'>,
  platform: Platform,
  args: RolloutArgs,
): Promise<void> {
  const started = performance.now()
  const { root, config } = ctx as { root: string; config: KitConfig }
  const flags = ctx.flags
  const plan = rolloutPlan(platform, args)
  requirePlatformConfig(config, platform)
  const summary = `${config.name} ${platform}: ${describeRollout(platform, plan)}`
  const doc = { platform, ...plan, dryRun: flags.dryRun }

  // ---- dry run: the plan, and nothing else
  if (flags.dryRun) {
    if (flags.json) emitJson({ ...doc, ok: true, changed: false, plan: [`fastlane ${platform} rollout`] })
    else {
      process.stderr.write(`\n${pc.bold(summary)}${pc.yellow('  [dry run: nothing runs]')}\n\n`)
      ctx.log.step(`fastlane ${platform} rollout`)
    }
    return
  }

  requireBundle()
  const appRoot = appFastlaneDir(root, config)
  const env: Record<string, string> = {
    ...storeCreds(platform),
    ...laneConfigEnv(root, config),
    KIT_ROLLOUT_ACTION: plan.action,
    ...(plan.fraction !== undefined ? { KIT_PLAY_ROLLOUT: String(plan.fraction) } : {}),
    ...(plan.build !== undefined ? { KIT_ANDROID_CODE: String(plan.build) } : {}),
  }

  if (!flags.json) process.stderr.write(`\n${pc.bold(summary)}\n\n`)
  if (!(await confirmRollout(flags, plan.action, summary))) {
    throw new KitError('Rollout cancelled', undefined, ExitCode.interrupted)
  }

  let outputs: Record<string, string> = {}
  const steps = [
    laneStep(
      `rollout ${plan.action}`,
      appRoot,
      platform,
      'rollout',
      () => env,
      (o) => {
        outputs = o
      },
    ),
  ]
  const results = await runSteps([{ title: platform, steps }], flags, { bail: true })
  if (results.some((r) => !r.ok) || results.length !== steps.length || interrupted()) {
    if (flags.json) emitJson({ ...doc, ok: false, changed: false, results })
    process.exitCode = summarize(
      `rollout ${platform}`,
      results,
      started,
      platform === 'android' && plan.action === 'percent'
        ? 'A halted rollout must be resumed first: kit release rollout android --resume'
        : undefined,
    )
    return
  }
  const state = outputs.ROLLOUT_STATE
  const fraction = outputs.ROLLOUT_FRACTION ? Number(outputs.ROLLOUT_FRACTION) : undefined
  const version = outputs.ROLLOUT_VERSION
  // Android: the version code of the release the lane changed.
  const code = Number(outputs.ROLLOUT_CODE)
  const build = Number.isInteger(code) && code > 0 ? code : undefined
  if (flags.json) {
    emitJson({
      ...doc,
      ok: true,
      changed: true,
      ...(build !== undefined ? { build } : {}),
      ...(state ? { state } : {}),
      ...(fraction !== undefined && Number.isFinite(fraction) ? { fraction } : {}),
      ...(version ? { version } : {}),
    })
  }
  summarize(`rollout ${platform}`, results, started)
  if (!flags.json && state) {
    ctx.log.dim(
      `  ${version ? `${version}: ` : ''}${build !== undefined ? `version code ${build}: ` : ''}${state}${fraction !== undefined ? ` at ${Math.round(fraction * 1000) / 10}%` : ''}`,
    )
  }
}
