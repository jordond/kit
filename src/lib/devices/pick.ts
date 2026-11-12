// The "which one" decisions behind `resolveDevice` (ported from brewd `lib/device-pick.ts`), pure so they are tested
// without an SDK on the box: what the newest, largest phone is on each platform,
// which installed system image an emulator should run, and which of several live
// devices `--yes` takes.

const PIXEL_SIZE_RANK: Readonly<Record<string, number>> = { pro_xl: 3, xl: 3, pro: 2, '': 1, a: 0 }

/**
 * The newest, largest Pixel among avdmanager's device ids (`pixel_10_pro_xl`,
 * `pixel_9a`, ...). Folds, tablets and the Pixel C are not phones the store shots
 * want, so a size the rank table does not name is skipped.
 */
export function latestLargestPixel(deviceIds: readonly string[]): string | undefined {
  let best: { id: string; generation: number; size: number } | undefined
  for (const id of deviceIds) {
    const match = /^pixel_(\d+)(?:_(.+))?$/.exec(id)
    if (match === null) continue
    const size = PIXEL_SIZE_RANK[match[2] ?? '']
    if (size === undefined) continue
    const generation = Number(match[1])
    if (
      best === undefined ||
      generation > best.generation ||
      (generation === best.generation && size > best.size)
    ) {
      best = { id, generation, size }
    }
  }
  return best?.id
}

const IPHONE_SIZE_RANK: Readonly<Record<string, number>> = {
  ' Pro Max': 4,
  ' Plus': 3,
  ' Pro': 2,
  '': 1,
  ' Air': 1,
  e: 0,
}

/** Where a simulator name sits in the line-up: generation first, then size. `undefined` for a non-iPhone. */
export function iphoneRank(name: string): readonly [generation: number, size: number] | undefined {
  const match = /^iPhone (\d+)( Pro Max| Plus| Pro| Air|e)?$/.exec(name)
  if (match === null) return undefined
  const size = IPHONE_SIZE_RANK[match[2] ?? '']
  if (size === undefined) return undefined
  return [Number(match[1]), size]
}

/** The newest, largest iPhone among the given names — the SE and the minis never win. */
export function latestLargestIphone<T extends { readonly name: string }>(types: readonly T[]): T | undefined {
  let best: { type: T; rank: readonly [number, number] } | undefined
  for (const type of types) {
    const rank = iphoneRank(type.name)
    if (rank === undefined) continue
    if (
      best === undefined ||
      rank[0] > best.rank[0] ||
      (rank[0] === best.rank[0] && rank[1] > best.rank[1])
    ) {
      best = { type, rank }
    }
  }
  return best?.type
}

const IPAD_LINE_RANK: Readonly<Record<string, number>> = { ' Pro': 3, ' Air': 2, '': 1, ' mini': 0 }

/**
 * Where a simulator name sits in the iPad line-up: screen inches first, then the chip
 * (`M5` over `M4`, any M over an A-series or a "(6th generation)"), then Pro over Air over
 * the plain one over the mini. `undefined` for a non-iPad.
 */
export function ipadRank(name: string): readonly [inches: number, chip: number, line: number] | undefined {
  const match =
    /^iPad( Pro| Air| mini)?(?: \(?(\d+(?:\.\d+)?)-inch\)?)?(?: \((?:(M|A)(\d+)(?: Pro)?|(\d+)\w+ generation)\))?$/.exec(
      name,
    )
  if (match === null) return undefined
  const line = IPAD_LINE_RANK[match[1] ?? '']
  if (line === undefined) return undefined
  const inches = Number(match[2] ?? 0)
  const chip = match[3] === 'M' ? 100 + Number(match[4]) : Number(match[4] ?? match[5] ?? 0)
  return [inches, chip, line]
}

/** The newest, largest iPad among the given names — the 13-inch the store wants, on the newest chip. */
export function latestLargestIpad<T extends { readonly name: string }>(types: readonly T[]): T | undefined {
  let best: { type: T; rank: readonly number[] } | undefined
  for (const type of types) {
    const rank = ipadRank(type.name)
    if (rank === undefined) continue
    if (best === undefined || compareRanks(rank, best.rank) > 0) best = { type, rank }
  }
  return best?.type
}

function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The highest of dotted version strings (`26.5` < `27.0`), by numeric parts. */
export function latestVersion<T extends { readonly version: string }>(items: readonly T[]): T | undefined {
  // `33-ext5` and `36.0-Baklava` are API dirs too: compare the leading number of each part.
  const parts = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10) || 0)
  let best: T | undefined
  for (const item of items) {
    if (best === undefined) {
      best = item
      continue
    }
    const a = parts(item.version)
    const b = parts(best.version)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0)
      if (diff > 0) best = item
      if (diff !== 0) break
    }
  }
  return best
}

export interface SystemImage {
  readonly api: string
  readonly tag: string
  readonly abi: string
}

/** The `-k` package avdmanager takes for an installed image. */
export function systemImagePackage({ api, tag, abi }: SystemImage): string {
  return `system-images;android-${api};${tag};${abi}`
}

/** Phone images only: TV, Wear, Automotive and desktop tags are not what an app's flows drive. */
const isPhoneImage = (tag: string): boolean => tag === 'default' || tag.startsWith('google_apis')

/**
 * The image a new emulator runs: a Play image whenever one is installed (the owner's rule: emulators
 * match what users run), newest API first. Without one, `google_apis` over AOSP `default`.
 * Play images refuse `adb root`, so app data is reached through `run-as` on a debuggable build.
 */
export function preferredSystemImage(
  images: readonly SystemImage[],
  hostAbi: string,
): SystemImage | undefined {
  const isPlay = (tag: string): boolean => tag.includes('playstore')
  // At one API: the plain Play image over its variants (16k pages), then google_apis, then AOSP.
  const tagRank = (tag: string): number =>
    tag === 'google_apis_playstore' ? 3 : isPlay(tag) ? 2 : tag === 'google_apis' ? 1 : 0
  const phones = images.filter((image) => image.abi === hostAbi && isPhoneImage(image.tag))
  const play = phones.filter((image) => isPlay(image.tag))
  const candidates = (play.length ? play : phones).map((image) => ({ image, version: image.api }))
  const newest = latestVersion(candidates)
  if (newest === undefined) return undefined
  return candidates
    .filter((c) => c.version === newest.version)
    .map((c) => c.image)
    .sort((x, y) => tagRank(y.tag) - tagRank(x.tag))[0]
}

export interface DeviceOption {
  readonly id: string
  readonly label: string
}

/** The simulator family an iOS run drives: the store wants an iPhone set and a 13-inch iPad set. */
export type SimFamily = 'iphone' | 'ipad'

export const isIpadName = (name: string): boolean => name.startsWith('iPad')

/**
 * The one `--yes` takes when several are already up: an emulator over a phone on
 * Android, since a cable often means someone's daily device; the newest, largest
 * iPhone or iPad on iOS; and the first listed when nothing separates them.
 */
export function preferredAmong(
  platform: 'android' | 'ios',
  devices: readonly DeviceOption[],
  family: SimFamily = 'iphone',
): DeviceOption {
  const [first] = devices
  if (first === undefined) throw new Error('no devices to choose from')
  if (platform === 'android') return devices.find((device) => device.id.startsWith('emulator-')) ?? first
  const named = devices.map((device) => ({ name: device.label.replace(/ \(.*\)$/, ''), device }))
  const pick = family === 'ipad' ? latestLargestIpad(named) : latestLargestIphone(named)
  return pick?.device ?? first
}
