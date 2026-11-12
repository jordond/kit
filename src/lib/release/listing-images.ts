import { readFileSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { type ImageInfo, imageInfo } from '../image/png'
import {
  APPLE_MAX_PER_CLASS,
  appleClass,
  PLAY_FEATURE_GRAPHIC,
  PLAY_ICON,
  PLAY_ICON_MAX_BYTES,
  PLAY_MAX_PER_TYPE,
  PLAY_MIN_PHONE,
  playProblems,
} from '../storeshots/sizes'

/**
 * The preflight of `kit release metadata push --screenshots`: every image the push would upload is
 * read and checked against what the store takes, before the confirmation and before a lane runs.
 * deliver deletes the store's screenshot sets before it uploads and drops what it cannot place, so
 * a file the store refuses must stop the push here. Nothing is rewritten: the fix is the caller's.
 */

export interface ListingImage {
  /** As given: relative to the repo root. */
  file: string
  /** The locale directory the file sits in; empty when it sits in none. */
  locale: string
  /** iOS: App Store Connect's display type, from the pixel size. Play: the image type (`phoneScreenshots`, `icon`, …). */
  class: string
  width: number
  height: number
}

export interface ImagePreflight {
  /** Every file that could be read as an image, in the order given. */
  images: ListingImage[]
  /** `<file>: <reason>`, one per broken rule: any of these stops the push. */
  problems: string[]
  /** Worth saying, not worth stopping for. */
  warnings: string[]
}

/** The class of an iOS image whose pixel size App Store Connect does not take. */
export const UNKNOWN_CLASS = 'unknown'

/** supply's SCREENSHOT_TYPES: a directory of images under `<locale>/images/`. */
const PLAY_SCREENSHOT_TYPES = [
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'tvScreenshots',
  'wearScreenshots',
]

const FORMAT_OF_EXT: Record<string, ImageInfo['format']> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg' }
const FORMAT_NAME = { png: 'PNG', jpeg: 'JPEG' } as const

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

/** Where a file sits in its store layout: the locale directory and, on Play, the image type. */
function place(platform: 'ios' | 'android', base: string, path: string): { locale: string; type: string } {
  const parts = relative(base, path).split(sep)
  if (platform === 'ios') {
    // deliver: <locale>/<file>, or appleTV|iMessage/<locale>/<file>.
    return { locale: parts.length > 1 ? parts[parts.length - 2]! : '', type: '' }
  }
  // supply: <locale>/images/<type>.<ext>, or <locale>/images/<type>/<file>.
  const rest = parts.slice(2)
  const type = rest.length > 1 ? rest[0]! : basename(rest[0] ?? '', extname(rest[0] ?? ''))
  return { locale: parts[0] ?? '', type }
}

/**
 * Check the images a push is about to upload. `files` are relative to `root`, in upload order;
 * `base` is the directory the locale directories sit in (deliver's screenshots dir on iOS, the
 * metadata dir on Android).
 */
export function checkListingImages(
  platform: 'ios' | 'android',
  root: string,
  base: string,
  files: string[],
): ImagePreflight {
  const images: ListingImage[] = []
  const problems: string[] = []
  const warnings: string[] = []
  const counts = new Map<string, number>()
  const phones = new Map<string, number>()

  for (const file of files) {
    const path = join(root, file)
    let bytes: Uint8Array
    let info: ImageInfo
    try {
      bytes = readFileSync(path)
      info = imageInfo(bytes)
    } catch (e) {
      problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const { width, height } = info
    const size = `${width}x${height}`
    const { locale, type } = place(platform, base, path)
    const ext = extname(file).toLowerCase()
    if (FORMAT_OF_EXT[ext] !== info.format) {
      problems.push(`${file}: a ${FORMAT_NAME[info.format]} image named ${ext}`)
    }
    const alphaAllowed = platform === 'android' && type === 'icon'
    if (info.alpha && !alphaAllowed) {
      problems.push(`${file}: has an alpha channel; the store takes opaque images only`)
    }

    let cls: string
    let max: number
    if (platform === 'ios') {
      cls = appleClass(width, height, path) ?? UNKNOWN_CLASS
      max = APPLE_MAX_PER_CLASS
      if (cls === UNKNOWN_CLASS) problems.push(`${file}: ${size} is not an App Store screenshot size`)
    } else {
      cls = type
      max = PLAY_MAX_PER_TYPE
      if (PLAY_SCREENSHOT_TYPES.includes(type)) {
        for (const p of playProblems(width, height)) problems.push(`${file}: ${p}`)
      } else if (type === 'featureGraphic') {
        if (width !== PLAY_FEATURE_GRAPHIC.width || height !== PLAY_FEATURE_GRAPHIC.height) {
          problems.push(
            `${file}: ${size}; the feature graphic must be ${PLAY_FEATURE_GRAPHIC.width}x${PLAY_FEATURE_GRAPHIC.height}`,
          )
        }
      } else if (type === 'icon') {
        if (width !== PLAY_ICON.width || height !== PLAY_ICON.height) {
          problems.push(`${file}: ${size}; the icon must be ${PLAY_ICON.width}x${PLAY_ICON.height}`)
        }
        if (bytes.length > PLAY_ICON_MAX_BYTES) {
          problems.push(
            `${file}: ${Math.ceil(bytes.length / 1024)} KB; the icon must be at most ${PLAY_ICON_MAX_BYTES / 1024} KB`,
          )
        }
      }
    }
    images.push({ file, locale, class: cls, width, height })

    // Counts: per locale and class on iOS, per locale and screenshot type on Play.
    const counted = platform === 'ios' ? cls !== UNKNOWN_CLASS : PLAY_SCREENSHOT_TYPES.includes(cls)
    if (!counted) continue
    const key = `${locale}\0${cls}`
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    if (platform === 'android' && cls === 'phoneScreenshots') phones.set(locale, n)
    if (n > max) {
      problems.push(
        `${file}: the ${ordinal(n)} ${cls} image of ${locale || 'no locale'}; the store keeps at most ${max}`,
      )
    }
  }

  for (const [locale, n] of phones) {
    if (n < PLAY_MIN_PHONE) {
      warnings.push(`${locale}: ${n} phone screenshot; Google Play asks for at least ${PLAY_MIN_PHONE}`)
    }
  }
  return { images, problems, warnings }
}

/** The card's image lines: per locale and class, the count and the pixel size(s). */
export function imageSummary(images: ListingImage[]): string[] {
  const groups = new Map<string, { locale: string; cls: string; count: number; sizes: Set<string> }>()
  for (const i of images) {
    const key = `${i.locale}\0${i.class}`
    const g = groups.get(key) ?? { locale: i.locale, cls: i.class, count: 0, sizes: new Set<string>() }
    g.count += 1
    g.sizes.add(`${i.width}x${i.height}`)
    groups.set(key, g)
  }
  return [...groups.values()].map(
    (g) => `${g.locale || '(no locale)'}  ${g.cls}  ${g.count} × ${[...g.sizes].join(', ')}`,
  )
}

/** The locales whose images are in the push, in first-seen order. */
export function imageLocales(images: ListingImage[]): string[] {
  return [...new Set(images.map((i) => i.locale).filter(Boolean))]
}
