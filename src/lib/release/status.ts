import pc from 'picocolors'
import type { KitContext } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import { interrupted } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { appFastlaneDir } from '../fastlane'
import { emitJson } from '../log'
import { runSteps, type Step } from '../steps'
import { appleCreds, playCreds } from './creds'
import { laneConfigEnv, laneStep, type Platform } from './mobile'
import { readVersion } from './version'

/**
 * `kit release status [ios|android]`: what each store track holds, read with the `status` lanes.
 * Nothing here mutates. A track the store would not answer for is `unknown` (with the reason), not a
 * failure; a platform fails only when none of its tracks could be read.
 */

export type TrackState = 'ok' | 'empty' | 'unknown'

export interface TrackStatus {
  /** Android: internal, alpha, beta, prod. iOS: testflight, prod (TestFlight has one build list). */
  track: string
  state: TrackState
  /** Latest build number (iOS) or highest version code (Android); null when empty or unknown. */
  build: number | null
  /** iOS: the version name of that build. */
  version?: string
  /** Android: every version code on the track. */
  codes?: number[]
  /** Android: release names on the track. */
  names?: string[]
  /** iOS prod: phased release state (ACTIVE, PAUSED, COMPLETE, INACTIVE); `unknown` when it could not be read. */
  phased?: string
  /** Why `phased` is unknown. Absent with no `phased`: the version has no phased release. */
  phasedError?: string
  /** Why the track is unknown. */
  error?: string
}

export interface PlatformStatus {
  platform: Platform
  /** Version name in the catalog TOML; null when it cannot be read. */
  version: string | null
  tracks: TrackStatus[]
  /** False when no track could be read. */
  ok: boolean
}

/** kit track → the key the android `status` lane emits (`KIT_STATUS_<KEY>_CODES`). */
export const PLAY_TRACK_KEYS = [
  ['internal', 'INTERNAL'],
  ['alpha', 'ALPHA'],
  ['beta', 'BETA'],
  ['prod', 'PRODUCTION'],
] as const

const unknown = (track: string, error?: string): TrackStatus => ({
  track,
  state: 'unknown',
  build: null,
  error: error || 'the lane reported nothing for this track',
})

function names(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : undefined
  } catch {
    return undefined
  }
}

/** Tracks from the android `status` lane's `KIT_STATUS_*` outputs (keys without the `KIT_` prefix). */
export function parseAndroidStatus(o: Record<string, string>): TrackStatus[] {
  return PLAY_TRACK_KEYS.map(([track, key]) => {
    const raw = o[`STATUS_${key}_CODES`]
    if (raw === undefined) return unknown(track, o[`STATUS_${key}_ERROR`])
    const codes = raw
      .split(',')
      .map((c) => Number(c.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b)
    const n = names(o[`STATUS_${key}_NAMES`])
    return {
      track,
      state: codes.length ? 'ok' : 'empty',
      build: codes.at(-1) ?? null,
      codes,
      ...(n ? { names: n } : {}),
    }
  })
}

/** Tracks from the ios `status` lane: `testflight` (latest build) and `prod` (the live App Store build). */
export function parseIosStatus(o: Record<string, string>): TrackStatus[] {
  const one = (track: string, key: string): TrackStatus => {
    const raw = o[`STATUS_${key}_BUILD`]
    if (raw === undefined) return unknown(track, o[`STATUS_${key}_ERROR`])
    const build = Number(raw)
    const has = raw !== '' && Number.isFinite(build) && build > 0
    const version = o[`STATUS_${key}_VERSION`]
    return {
      track,
      state: has ? 'ok' : 'empty',
      build: has ? build : null,
      ...(has && version ? { version } : {}),
    }
  }
  const prod = one('prod', 'APPSTORE')
  if (o.STATUS_APPSTORE_PHASED) prod.phased = o.STATUS_APPSTORE_PHASED
  else if (o.STATUS_APPSTORE_PHASED_ERROR !== undefined) {
    prod.phased = 'unknown'
    prod.phasedError = o.STATUS_APPSTORE_PHASED_ERROR || 'the lane could not read it'
  }
  return [one('testflight', 'TESTFLIGHT'), prod]
}

export const parseStatus = (platform: Platform, o: Record<string, string>): TrackStatus[] =>
  platform === 'ios' ? parseIosStatus(o) : parseAndroidStatus(o)

/** `ios` or `android` from a positional, or exit 2 naming the command's usage. */
export function requirePlatform(value: string | undefined, usage: string): Platform {
  if (value !== 'ios' && value !== 'android') {
    throw new KitError(
      `${usage.split(' <')[0]} needs a platform: ios or android${value ? ` (got "${value}")` : ''}`,
      usage,
      ExitCode.usage,
    )
  }
  return value
}

/** The platform's `release.<platform>` block exists, or exit 3. */
export function requirePlatformConfig(config: KitConfig, platform: Platform): void {
  if (!config.release?.[platform]) {
    throw new KitError(`No release.${platform} in kit.config.ts`, undefined, ExitCode.config)
  }
}

/** Store lanes need Bundler only (no Xcode, no JDK: nothing is built). */
export function requireBundle(which: (bin: string) => string | null = Bun.which): void {
  if (!which('bundle')) {
    throw new KitError('Missing tools: bundle', 'Run `kit doctor` (Ruby + Bundler)', ExitCode.precondition)
  }
}

/** Store credentials for lanes that only talk to the store: the ASC key, or the Play service account. */
export function storeCreds(platform: Platform): Record<string, string> {
  return platform === 'ios' ? appleCreds({ match: false, ci: false }).env : playCreds()
}

function line(t: TrackStatus): string {
  const label = t.track.padEnd(11)
  if (t.state === 'unknown') return `  ${label}unknown${t.error ? pc.dim(` (${t.error})`) : ''}`
  if (t.state === 'empty') return `  ${label}${pc.dim('no build')}`
  const extra = [
    t.version,
    t.names?.length ? t.names.join(', ') : undefined,
    t.codes && t.codes.length > 1 ? `codes ${t.codes.join(', ')}` : undefined,
    t.phased ? `phased ${t.phased}${t.phasedError ? ` (${t.phasedError})` : ''}` : undefined,
  ].filter(Boolean)
  return `  ${label}${t.build}${extra.length ? pc.dim(`  ${extra.join(' · ')}`) : ''}`
}

export async function releaseStatus(
  ctx: Pick<KitContext, 'root' | 'config' | 'flags' | 'log'>,
  only?: Platform,
): Promise<void> {
  const { root, config } = ctx as { root: string; config: KitConfig }
  if (only) requirePlatformConfig(config, only)
  const platforms = only ? [only] : (['ios', 'android'] as const).filter((p) => !!config.release?.[p])
  if (!platforms.length) {
    throw new KitError('No release.ios or release.android in kit.config.ts', undefined, ExitCode.config)
  }
  requireBundle()
  const appRoot = appFastlaneDir(root, config)
  const outputs: Partial<Record<Platform, Record<string, string>>> = {}
  const steps: Step[] = platforms.map((platform) => {
    const env = { ...storeCreds(platform), ...laneConfigEnv(root, config) }
    return laneStep(
      `${platform} status`,
      appRoot,
      platform,
      'status',
      () => env,
      (o) => {
        outputs[platform] = o
      },
    )
  })
  const results = await runSteps([{ title: 'status', steps }], ctx.flags)

  const report: PlatformStatus[] = platforms.map((platform) => {
    let version: string | null = null
    try {
      version = readVersion(root, config, platform)
    } catch {
      // no versions.file or key: the store answer still stands
    }
    const failed = results.find((r) => r.title === `${platform} status` && !r.ok)
    const tracks = outputs[platform]
      ? parseStatus(platform, outputs[platform])
      : parseStatus(platform, {}).map((t) => ({
          ...t,
          error: failed?.error ?? 'the status lane did not run',
        }))
    return { platform, version, tracks, ok: tracks.some((t) => t.state !== 'unknown') }
  })
  const ok = report.every((p) => p.ok)

  for (const p of report) {
    for (const t of p.tracks.filter((x) => x.state === 'unknown')) {
      ctx.log.warn(`${p.platform} ${t.track}: unknown${t.error ? ` (${t.error})` : ''}`)
    }
    for (const t of p.tracks.filter((x) => x.phasedError)) {
      ctx.log.warn(`${p.platform} ${t.track}: phased release unknown (${t.phasedError})`)
    }
  }
  if (ctx.flags.json) {
    emitJson({ ok, platforms: report })
  } else {
    for (const p of report) {
      process.stdout.write(`${pc.bold(p.platform)}${p.version ? ` ${p.version}` : ''}\n`)
      for (const t of p.tracks) process.stdout.write(`${line(t)}\n`)
    }
  }
  if (!ok) {
    const none = report.filter((p) => !p.ok).map((p) => p.platform)
    ctx.log.error(`No track could be read for ${none.join(', ')}`, 'Check the store credentials in .env')
    process.exitCode = interrupted() ? ExitCode.interrupted : ExitCode.failed
  }
}
