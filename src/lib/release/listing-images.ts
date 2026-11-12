import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { type ImageInfo, imageInfo } from '../image/png'
import {
  APPLE_MAX_PER_CLASS,
  appleClass,
  PLAY_FEATURE_GRAPHIC,
  PLAY_ICON,
  PLAY_ICON_MAX_BYTES,
  PLAY_MAX_PER_TYPE,
  PLAY_MIN_PHONE,
  PLAY_TV_BANNER,
  playProblems,
} from '../storeshots/sizes'

/**
 * The preflight of `kit release metadata push --screenshots`: every image the push would upload is
 * read and checked against what the store takes, before the confirmation and before a lane runs.
 * deliver deletes the store's screenshot sets before it uploads and drops what it cannot place, so
 * a file the store refuses must stop the push here. Nothing is rewritten: the fix is the caller's.
 *
 * The files are found the way the uploader finds them (`listingImageFiles`), not by walking the
 * directory: what fastlane never uploads is neither checked nor counted, and a directory deliver
 * would stop at, or load with no locale, is a problem. The rules are those of the pinned fastlane
 * gem (2.241.2): `deliver/lib/deliver/loader.rb`, `app_screenshot.rb`, `upload_screenshots.rb` and
 * `supply/lib/supply/uploader.rb`. Read them again when `fastlane/Gemfile.lock` moves.
 */

export interface ListingImage {
  /** Relative to the repo root. */
  file: string
  /** The locale the uploader files it under: deliver's language (iOS), supply's locale directory (Play). */
  locale: string
  /** iOS: App Store Connect's display type, from the pixel size and the path. Play: the image type (`phoneScreenshots`, `icon`, …). */
  class: string
  width: number
  height: number
}

export interface ImagePreflight {
  /** Every file the uploader would take, relative to the repo root, in upload order. */
  files: string[]
  /** Those of `files` that could be read as an image. */
  images: ListingImage[]
  /** `<file or directory>: <reason>`, one per broken rule: any of these stops the push. */
  problems: string[]
  /** Worth saying, not worth stopping for. */
  warnings: string[]
}

/** A file the uploader would take. */
export interface ListingImageFile {
  /** Absolute. */
  path: string
  locale: string
  /** Play: supply's image type. iOS: empty, the display type comes from the pixels. */
  type: string
}

export interface ListingImageFiles {
  files: ListingImageFile[]
  /** iOS: directories deliver stops at, or loads images from with no locale. `path` is absolute. */
  refused: { path: string; reason: string }[]
}

/** The reason for an entry the uploader's glob returns that is not a file it can read. */
export const NOT_A_FILE =
  'not a regular file (a directory, or a link to nothing); fastlane would still try to upload it'

/** The class of an iOS image whose pixel size App Store Connect does not take. */
export const UNKNOWN_CLASS = 'unknown'

/** supply's IMAGES_TYPES: one file each, `<locale>/images/<type>.<ext>`. */
const PLAY_IMAGE_TYPES = ['featureGraphic', 'icon', 'tvBanner']
/** supply's SCREENSHOT_TYPES: a directory of images each, `<locale>/images/<type>/`. */
const PLAY_SCREENSHOT_TYPES = [
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'tvScreenshots',
  'wearScreenshots',
]

/**
 * The locales deliver takes as a directory name: `FastlaneCore::Languages::ALL_LANGUAGES` in the
 * pinned fastlane gem (2.241.2, `fastlane_core/lib/fastlane_core/languages.rb`), which
 * `Deliver::Loader::LanguageFolder` matches whatever the case. Copy it again when
 * `fastlane/Gemfile.lock` moves.
 */
export const DELIVER_LANGUAGES = [
  ...['ar-SA', 'bn-BD', 'ca', 'cs', 'da', 'de-DE', 'el', 'en-AU', 'en-CA', 'en-GB', 'en-US', 'es-ES'],
  ...['es-MX', 'fi', 'fr-CA', 'fr-FR', 'gu-IN', 'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn-IN', 'ko'],
  ...['ml-IN', 'mr-IN', 'ms', 'nl-NL', 'no', 'or-IN', 'pa-IN', 'pl', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk'],
  ...['sl-SI', 'sv', 'ta-IN', 'te-IN', 'th', 'tr', 'uk', 'ur-PK', 'vi', 'zh-Hans', 'zh-Hant'],
]
/** deliver's EXPANDABLE_DIR_NAMES (`appleTV`, `iMessage`), lowercased: their locale directories are read too. */
const DELIVER_EXPANDABLE = ['appletv', 'imessage']
/** deliver's DEFAULT_DIR_NAME: a name it accepts, with no language. */
const DELIVER_DEFAULT = 'default'
/** deliver's EXCEPTION_DIRECTORIES: never read, never an error. */
const DELIVER_SKIPPED = [
  'trade_representative_contact_information',
  'review_information',
  'app_clip_review_information',
  'android',
  'fonts',
]

/** `*.{png,jpg,jpeg}` under File::FNM_CASEFOLD; `*` does not match a leading dot. */
const GLOB_IMAGE = /^[^.].*\.(png|jpg|jpeg)$/i
/** `*_framed.{png,jpg,jpeg}`, likewise. */
const GLOB_FRAMED = /^([^.].*)?_framed\.(png|jpg|jpeg)$/i

const FORMAT_OF_EXT: Record<string, ImageInfo['format']> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg' }
const FORMAT_NAME = { png: 'PNG', jpeg: 'JPEG' } as const

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

/** Ruby's String order (by byte): the order of a sorted Dir.glob. */
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

/** What `Dir.glob("<dir>/*")` yields: the entries without a leading dot, sorted. */
function entries(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir)
    .filter((e) => !e.startsWith('.'))
    .sort(byBytes)
}

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true

/** Where a name falls in the brace `{png,jpg,jpeg}`: Dir.glob returns the matches of each in turn. */
const BRACE_ORDER = ['.png', '.jpg', '.jpeg']
const braceRank = (name: string) => BRACE_ORDER.indexOf(extname(name).toLowerCase())

/** deliver's `Loader.load_app_screenshots`: `<locale>/*` and `appleTV|iMessage/<locale>/*`. */
function deliverFiles(base: string): ListingImageFiles {
  const files: ListingImageFile[] = []
  const refused: ListingImageFiles['refused'] = []
  const language = (name: string) => DELIVER_LANGUAGES.find((l) => l.toLowerCase() === name.toLowerCase())
  const expandable = (name: string) => DELIVER_EXPANDABLE.includes(name.toLowerCase())
  const valid = (name: string) =>
    language(name) !== undefined || expandable(name) || name.toLowerCase() === DELIVER_DEFAULT

  const folders: string[] = []
  for (const name of entries(base)) {
    const dir = join(base, name)
    if (!isDir(dir) || DELIVER_SKIPPED.includes(name.toLowerCase())) continue
    if (!valid(name)) {
      // "Unsupported directory name(s) for screenshots/metadata": deliver stops there.
      refused.push({
        path: dir,
        reason:
          'deliver does not take this directory name; name it after an App Store locale (en-US, fr-FR, …), or appleTV or iMessage',
      })
    } else if (expandable(name)) {
      // Its sub-directories with a valid name; deliver drops the others without a word.
      for (const sub of entries(dir)) if (isDir(join(dir, sub)) && valid(sub)) folders.push(join(dir, sub))
    } else folders.push(dir)
  }

  for (const dir of folders) {
    const locale = language(basename(dir))
    let names = entries(dir).filter((e) => GLOB_IMAGE.test(e))
    if (!locale) {
      // `default`, or appleTV|iMessage inside one of them. With no image there deliver loads
      // nothing from it. With one, it loads the files with a nil language, deletes the screenshot
      // sets of the real locales, then fails creating a nil one.
      if (!names.length) continue
      refused.push({
        path: dir,
        reason:
          'deliver gives this directory no locale and fails after it has deleted the store’s screenshots; move its files into a locale directory (en-US, fr-FR, …)',
      })
      continue
    }
    // Framed mode: with one `*_framed` file, only the paths naming "framed" or "watch" go up.
    if (names.some((e) => GLOB_FRAMED.test(e))) {
      names = names.filter((e) => /framed|watch/.test(join(dir, e).toLowerCase()))
    }
    // Whatever the glob matches, a directory or a dangling link too: deliver loads those as well.
    for (const e of names) files.push({ path: join(dir, e), locale, type: '' })
  }
  return { files, refused }
}

/** supply's `upload_images` and `upload_screenshots`, over every locale directory. */
function supplyFiles(base: string): ListingImageFiles {
  const files: ListingImageFile[] = []
  for (const locale of entries(base)) {
    if (!isDir(join(base, locale))) continue
    const images = join(base, locale, 'images')
    const found = entries(images)
    for (const type of PLAY_IMAGE_TYPES) {
      // `Dir.glob("<type>.{png,jpg,jpeg}").last`, whatever the case: the matches come in brace
      // order (png, then jpg, then jpeg), sorted within one extension, and supply uploads the last,
      // a directory or a dangling link too.
      const name = found
        .filter((e) => GLOB_IMAGE.test(e) && basename(e, extname(e)).toLowerCase() === type.toLowerCase())
        .sort((a, b) => braceRank(a) - braceRank(b) || byBytes(a, b))
        .at(-1)
      if (name) files.push({ path: join(images, name), locale, type })
    }
    for (const type of PLAY_SCREENSHOT_TYPES) {
      for (const dir of found.filter((e) => e.toLowerCase() === type.toLowerCase())) {
        for (const e of entries(join(images, dir))) {
          const path = join(images, dir, e)
          if (GLOB_IMAGE.test(e)) files.push({ path, locale, type })
        }
      }
    }
  }
  return { files, refused: [] }
}

/**
 * The images a push uploads, found as the uploader finds them. `base` is the directory the locale
 * directories sit in: deliver's screenshots dir on iOS, the metadata dir on Android.
 *
 * iOS (deliver): the images directly in `<locale>/` and in `appleTV|iMessage/<locale>/`. Files at
 * the root, in deeper directories, and in `fonts/`, `android/` and deliver's own metadata
 * directories are not uploaded. A locale directory with a `*_framed` file sends only its framed
 * (and watch) files. Android (supply): `<locale>/images/<type>.<ext>` for the image types and
 * `<locale>/images/<type>/*` for the screenshot types, nothing else. An entry with an image name
 * that is not a regular file is in the list: the uploader's glob returns it too.
 */
export function listingImageFiles(platform: 'ios' | 'android', base: string): ListingImageFiles {
  return platform === 'ios' ? deliverFiles(base) : supplyFiles(base)
}

/**
 * Check the images a push is about to upload: those `listingImageFiles` finds under `base`.
 * Paths in the result are relative to `root`.
 */
export function checkListingImages(platform: 'ios' | 'android', root: string, base: string): ImagePreflight {
  const found = listingImageFiles(platform, base)
  const files = found.files.map((f) => relative(root, f.path))
  const images: ListingImage[] = []
  const problems = found.refused.map((r) => `${relative(root, r.path)}: ${r.reason}`)
  const warnings: string[] = []
  const counts = new Map<string, number>()
  const phones = new Map<string, number>()

  for (const [index, { path, locale, type }] of found.files.entries()) {
    const file = files[index]!
    // The glob returns a directory or a dangling link with an image name, and the lane fails on it.
    if (!isFile(path)) {
      problems.push(`${file}: ${NOT_A_FILE}`)
      continue
    }
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
      // The path deliver is given: it decides iMessage, and the class of a size in two classes.
      cls = appleClass(width, height, path) ?? UNKNOWN_CLASS
      max = APPLE_MAX_PER_CLASS
      if (cls === UNKNOWN_CLASS) {
        const where = path.split('/').filter(Boolean).at(-3) === 'iMessage' ? 'iMessage' : 'App Store'
        problems.push(`${file}: ${size} is not an ${where} screenshot size`)
      }
    } else {
      cls = type
      max = PLAY_MAX_PER_TYPE
      const exact = (name: string, want: { width: number; height: number }) => {
        if (width !== want.width || height !== want.height) {
          problems.push(`${file}: ${size}; the ${name} must be ${want.width}x${want.height}`)
        }
      }
      if (PLAY_SCREENSHOT_TYPES.includes(type)) {
        for (const p of playProblems(width, height)) problems.push(`${file}: ${p}`)
      } else if (type === 'featureGraphic') exact('feature graphic', PLAY_FEATURE_GRAPHIC)
      else if (type === 'tvBanner') exact('TV banner', PLAY_TV_BANNER)
      else if (type === 'icon') {
        exact('icon', PLAY_ICON)
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
      problems.push(`${file}: the ${ordinal(n)} ${cls} image of ${locale}; the store keeps at most ${max}`)
    }
  }

  for (const [locale, n] of phones) {
    if (n < PLAY_MIN_PHONE) {
      warnings.push(`${locale}: ${n} phone screenshot; Google Play asks for at least ${PLAY_MIN_PHONE}`)
    }
  }
  return { files, images, problems, warnings }
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
  return [...groups.values()].map((g) => `${g.locale}  ${g.cls}  ${g.count} × ${[...g.sizes].join(', ')}`)
}

/** The locales whose images are in the push, in first-seen order. */
export function imageLocales(images: ListingImage[]): string[] {
  return [...new Set(images.map((i) => i.locale))]
}

/** The characters `Dir.glob` reads as part of a pattern, not of a name. */
const GLOB_CHARS = ['[', ']', '{', '}', '*', '?', '\\']

/**
 * The glob characters in `path`, once each, in the order found. deliver and supply find the images
 * with `Dir.glob(File.join(<path>, …))` and do not escape the path: with one of these in it the
 * pattern matches nothing (or other directories), the lane uploads nothing and still succeeds.
 */
export function globChars(path: string): string[] {
  return [...new Set(path)].filter((c) => GLOB_CHARS.includes(c))
}
