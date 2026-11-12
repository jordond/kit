import type { KitConfig } from '../../config/schema'
import type { DeviceTarget } from '../devices'
import { ExitCode, KitError } from '../errors'

/**
 * Store screenshot sizes: what `kit shots export` renders each set at, and what the stores take
 * (`kit release metadata push --screenshots` checks the listing against these before it uploads).
 */

export const STORES = ['apple', 'google'] as const
export type Store = (typeof STORES)[number]

/** The targets a store upload takes, in order: App Store Connect wants an iPad set beside the iPhone one. */
export const STORE_TARGETS: Record<Store, readonly DeviceTarget[]> = {
  apple: ['ios', 'ipad'],
  google: ['android'],
}

/** The store a target's screenshots go to. */
export const storeOf = (target: DeviceTarget): Store => (target === 'android' ? 'google' : 'apple')

/** `--store apple|google|both` as stores, in `STORES` order; anything else is a usage error. */
export function parseStores(value: string | undefined): Store[] {
  if (value === undefined || value === 'both') return [...STORES]
  if ((STORES as readonly string[]).includes(value)) return [value as Store]
  throw new KitError(`Unknown store "${value}"`, '--store takes apple, google or both', ExitCode.usage)
}

export interface Size {
  width: number
  height: number
}

type SetsConfig = Required<NonNullable<NonNullable<KitConfig['shots']>['sets']>>

/** A named export size (`shots.sets.<target>` in kit.config.ts). */
export type SetId = SetsConfig[DeviceTarget]

/** Portrait pixel size of each set. Every Apple size is in `APPLE_SIZES`; `phone` is 9:16, inside Play's 2:1. */
export const SET_SIZES: Record<SetId, Size> = {
  'iphone-6.9': { width: 1320, height: 2868 },
  'iphone-6.5': { width: 1284, height: 2778 },
  'iphone-6.3': { width: 1206, height: 2622 },
  'ipad-13': { width: 2064, height: 2752 },
  phone: { width: 1440, height: 2560 },
}

/** The set a target is exported at when `shots.sets` does not name one. */
export const DEFAULT_SETS: { [T in DeviceTarget]: SetsConfig[T] } = {
  ios: 'iphone-6.9',
  ipad: 'ipad-13',
  android: 'phone',
}

/** The set of every target: `shots.sets` over the defaults. */
export function resolveSets(config: Pick<KitConfig, 'shots'>): Record<DeviceTarget, SetId> {
  return { ...DEFAULT_SETS, ...config.shots?.sets }
}

/**
 * Sizes App Store Connect takes, keyed by display type: a copy of `DEVICE_RESOLUTIONS` in the
 * pinned fastlane gem (2.241.2, `deliver/lib/deliver/app_screenshot.rb`), in its order. deliver
 * picks the screenshot set from the pixel size alone, so a size outside this table is not uploaded.
 * Update it when `fastlane/Gemfile.lock` moves.
 */
export const APPLE_SIZES = {
  APP_IPHONE_67: [
    [1260, 2736],
    [2736, 1260],
    [1290, 2796],
    [2796, 1290],
    [1320, 2868],
    [2868, 1320],
  ],
  APP_IPHONE_65: [
    [1242, 2688],
    [2688, 1242],
    [1284, 2778],
    [2778, 1284],
  ],
  APP_IPHONE_61: [
    [1179, 2556],
    [2556, 1179],
    [1206, 2622],
    [2622, 1206],
  ],
  APP_IPHONE_58: [
    [1170, 2532],
    [2532, 1170],
    [1125, 2436],
    [2436, 1125],
    [1080, 2340],
    [2340, 1080],
  ],
  APP_IPHONE_55: [
    [1242, 2208],
    [2208, 1242],
  ],
  APP_IPHONE_47: [
    [750, 1334],
    [1334, 750],
  ],
  APP_IPHONE_40: [
    [640, 1096],
    [640, 1136],
    [1136, 600],
    [1136, 640],
  ],
  APP_IPHONE_35: [
    [640, 920],
    [640, 960],
    [960, 600],
    [960, 640],
  ],
  APP_IPHONE_DUO: [
    [1398, 2034],
    [2034, 1398],
    [2007, 2853],
    [2853, 2007],
  ],
  APP_IPAD_97: [
    [1024, 748],
    [1024, 768],
    [2048, 1496],
    [2048, 1536],
    [768, 1004],
    [768, 1024],
    [1536, 2008],
    [1536, 2048],
  ],
  APP_IPAD_105: [
    [1668, 2224],
    [2224, 1668],
  ],
  APP_IPAD_PRO_3GEN_11: [
    [1488, 2266],
    [2266, 1488],
    [1668, 2420],
    [2420, 1668],
    [1668, 2388],
    [2388, 1668],
    [1640, 2360],
    [2360, 1640],
  ],
  APP_IPAD_PRO_129: [
    [2048, 2732],
    [2732, 2048],
  ],
  APP_IPAD_PRO_3GEN_129: [
    [2048, 2732],
    [2732, 2048],
    [2064, 2752],
    [2752, 2064],
  ],
  APP_DESKTOP: [
    [1280, 800],
    [1440, 900],
    [2560, 1600],
    [2880, 1800],
  ],
  APP_WATCH_SERIES_3: [[312, 390]],
  APP_WATCH_SERIES_4: [[368, 448]],
  APP_WATCH_SERIES_7: [[396, 484]],
  APP_WATCH_SERIES_10: [[416, 496]],
  APP_WATCH_ULTRA: [
    [410, 502],
    [422, 514],
  ],
  APP_APPLE_TV: [
    [1920, 1080],
    [3840, 2160],
  ],
  APP_APPLE_VISION_PRO: [[3840, 2160]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>

/** An App Store Connect display type: the screenshot set an image lands in. */
export type AppleClass = keyof typeof APPLE_SIZES

/** The display type each Apple set id is uploaded as. */
export const APPLE_SET_CLASS: Record<Exclude<SetId, 'phone'>, AppleClass> = {
  'iphone-6.9': 'APP_IPHONE_67',
  'iphone-6.5': 'APP_IPHONE_65',
  'iphone-6.3': 'APP_IPHONE_61',
  'ipad-13': 'APP_IPAD_PRO_3GEN_129',
}

/**
 * The display type deliver gives an image of this pixel size, or undefined when App Store Connect
 * takes no such size. Orientation matters: the table lists each one it accepts.
 *
 * Two sizes are in two classes; deliver decides from the path, so pass it when there is one:
 * 2048x2732 is `APP_IPAD_PRO_3GEN_129` unless the path names `app_ipad_pro_129` or a
 * "12.9 … 2nd generation" dir, and 3840x2160 is `APP_APPLE_TV` unless the path contains "vision".
 */
export function appleClass(width: number, height: number, path?: string): AppleClass | undefined {
  const match = (Object.keys(APPLE_SIZES) as AppleClass[]).find((c) =>
    APPLE_SIZES[c].some(([w, h]) => w === width && h === height),
  )
  if (!match) return undefined
  const lower = path?.toLowerCase() ?? ''
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  if (long === 2732 && short === 2048) {
    const secondGen =
      lower.includes('app_ipad_pro_129') || (lower.includes('12.9') && lower.includes('2nd generation'))
    return secondGen ? 'APP_IPAD_PRO_129' : 'APP_IPAD_PRO_3GEN_129'
  }
  if (width === 3840 && height === 2160)
    return lower.includes('vision') ? 'APP_APPLE_VISION_PRO' : 'APP_APPLE_TV'
  return match
}

/** App Store Connect keeps at most this many screenshots per locale and display type; deliver drops the rest. */
export const APPLE_MAX_PER_CLASS = 10

/** Play screenshots: each side within these bounds, the long side at most `PLAY_MAX_RATIO` times the short. */
export const PLAY_MIN_SIDE = 320
export const PLAY_MAX_SIDE = 3840
export const PLAY_MAX_RATIO = 2
/** Play keeps at most this many screenshots per type (`phoneScreenshots`, …) and locale. */
export const PLAY_MAX_PER_TYPE = 8
/** Play asks for at least this many phone screenshots; fewer is a warning, not a refusal. */
export const PLAY_MIN_PHONE = 2
/** Play's `featureGraphic`: exactly this size, no alpha. */
export const PLAY_FEATURE_GRAPHIC: Size = { width: 1024, height: 500 }
/** Play's `icon`: exactly this size, at most `PLAY_ICON_MAX_BYTES`; alpha is allowed. */
export const PLAY_ICON: Size = { width: 512, height: 512 }
export const PLAY_ICON_MAX_BYTES = 1024 * 1024

/**
 * Why Play refuses a screenshot of this pixel size: one sentence per broken rule, empty when it is
 * accepted. Covers the size rules only (sides 320 to 3840, long side at most twice the short);
 * counts, alpha, the feature graphic and the icon are the caller's.
 */
export function playProblems(width: number, height: number): string[] {
  const problems: string[] = []
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  if (short < PLAY_MIN_SIDE)
    problems.push(`${width}x${height}: each side must be at least ${PLAY_MIN_SIDE} px`)
  if (long > PLAY_MAX_SIDE) problems.push(`${width}x${height}: each side must be at most ${PLAY_MAX_SIDE} px`)
  if (long > short * PLAY_MAX_RATIO) {
    problems.push(`${width}x${height}: the long side must be at most ${PLAY_MAX_RATIO}x the short side`)
  }
  return problems
}
