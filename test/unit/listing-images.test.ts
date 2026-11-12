import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { encodePng } from '../../src/lib/image/png'
import {
  checkListingImages,
  DELIVER_LANGUAGES,
  imageLocales,
  imageSummary,
  listingImageFiles,
} from '../../src/lib/release/listing-images'

const cache = new Map<string, Uint8Array>()

/** An opaque (RGB) or, with `alpha`, an RGBA PNG of this size. */
function png(width: number, height: number, alpha = false): Uint8Array {
  const key = `${width}x${height}${alpha ? 'a' : ''}`
  let bytes = cache.get(key)
  if (!bytes) {
    bytes = encodePng(width, height, new Uint8Array(width * height * (alpha ? 4 : 3)))
    cache.set(key, bytes)
  }
  return bytes
}

/** The smallest JPEG header imageInfo reads: SOI, then a baseline frame of this size. */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...[0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08],
    ...[height >> 8, height & 0xff, width >> 8, width & 0xff],
    ...[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01],
    ...[0xff, 0xd9],
  ])
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-listing-images-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function put(path: string, body: Uint8Array | string): string {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), body)
  return path
}

const drop = (path: string) => rmSync(join(root, path), { recursive: true })

const SHOTS = 'fastlane/screenshots'
const PLAY = 'fastlane/metadata/android'
/** The preflight of what is on disk: the files are found as deliver and supply find them. */
const ios = () => checkListingImages('ios', root, join(root, SHOTS))
const android = () => checkListingImages('android', root, join(root, PLAY))

const IPHONE = () => png(1320, 2868)

describe('checkListingImages: both stores', () => {
  test('a clean set has no problems and reports each file', () => {
    const files = [
      put(`${SHOTS}/en-US/01_iphone.png`, IPHONE()),
      put(`${SHOTS}/en-US/02_ipad.jpg`, jpeg(2064, 2752)),
      put(`${SHOTS}/fr-FR/01_iphone.JPEG`, jpeg(1320, 2868)),
    ]
    expect(ios()).toEqual({
      files,
      images: [
        { file: files[0]!, locale: 'en-US', class: 'APP_IPHONE_67', width: 1320, height: 2868 },
        { file: files[1]!, locale: 'en-US', class: 'APP_IPAD_PRO_3GEN_129', width: 2064, height: 2752 },
        { file: files[2]!, locale: 'fr-FR', class: 'APP_IPHONE_67', width: 1320, height: 2868 },
      ],
      problems: [],
      warnings: [],
    })
  })

  test('the magic bytes must match the extension', () => {
    const a = put(`${SHOTS}/en-US/a.png`, jpeg(1320, 2868))
    const b = put(`${SHOTS}/en-US/b.jpg`, IPHONE())
    const r = ios()
    expect(r.problems).toEqual([`${a}: a JPEG image named .png`, `${b}: a PNG image named .jpg`])
    expect(r.images.map((i) => i.file)).toEqual([a, b])
  })

  test('a file that is no image is a problem, in files and not in images', () => {
    const a = put(`${SHOTS}/en-US/a.png`, 'x')
    const r = ios()
    expect(r.files).toEqual([a])
    expect(r.images).toEqual([])
    expect(r.problems).toEqual([`${a}: Not a PNG or JPEG image`])
  })

  test('alpha is refused on both stores', () => {
    const a = put(`${SHOTS}/en-US/a.png`, png(1320, 2868, true))
    expect(ios().problems).toEqual([`${a}: has an alpha channel; the store takes opaque images only`])
    const b = put(`${PLAY}/en-US/images/phoneScreenshots/1.png`, png(1440, 2560, true))
    put(`${PLAY}/en-US/images/phoneScreenshots/2.png`, png(1440, 2560))
    expect(android().problems).toEqual([`${b}: has an alpha channel; the store takes opaque images only`])
  })

  test('nothing on disk is nothing to check', () => {
    const empty = { files: [], images: [], problems: [], warnings: [] }
    expect(ios()).toEqual(empty)
    expect(android()).toEqual(empty)
  })
})

describe('checkListingImages: iOS', () => {
  test('a size outside Apple’s table is a problem; orientation counts', () => {
    const a = put(`${SHOTS}/en-US/a.png`, png(1344, 2992))
    put(`${SHOTS}/en-US/b.png`, png(2868, 1320))
    const r = ios()
    expect(r.problems).toEqual([`${a}: 1344x2992 is not an App Store screenshot size`])
    expect(r.images.map((i) => i.class)).toEqual(['unknown', 'APP_IPHONE_67'])
  })

  test('at most 10 per locale and class: each one past the tenth is named', () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      put(`${SHOTS}/en-US/${String(i + 1).padStart(2, '0')}.png`, IPHONE()),
    )
    // other classes and locales have their own count
    put(`${SHOTS}/en-US/ipad.png`, png(2064, 2752))
    put(`${SHOTS}/de-DE/01.png`, IPHONE())
    expect(ios().problems).toEqual([
      `${files[10]}: the 11th APP_IPHONE_67 image of en-US; the store keeps at most 10`,
      `${files[11]}: the 12th APP_IPHONE_67 image of en-US; the store keeps at most 10`,
    ])
    drop(files[10]!)
    drop(files[11]!)
    expect(ios().problems).toEqual([])
  })

  test('appleTV/<locale>/ is read, under its locale', () => {
    const a = put(`${SHOTS}/appleTV/en-US/a.png`, png(1920, 1080))
    expect(ios().images).toEqual([
      { file: a, locale: 'en-US', class: 'APP_APPLE_TV', width: 1920, height: 1080 },
    ])
  })

  test('iMessage/<locale>/ is its own class: 10 app screenshots and an iMessage one pass', () => {
    for (let i = 0; i < 10; i++) put(`${SHOTS}/en-US/${i}.png`, IPHONE())
    const m = put(`${SHOTS}/iMessage/en-US/0.png`, IPHONE())
    const r = ios()
    expect(r.problems).toEqual([])
    expect(r.images.at(-1)).toEqual({
      file: m,
      locale: 'en-US',
      class: 'IMESSAGE_APP_IPHONE_67',
      width: 1320,
      height: 2868,
    })
    expect(imageSummary(r.images)).toEqual([
      'en-US  APP_IPHONE_67  10 × 1320x2868',
      'en-US  IMESSAGE_APP_IPHONE_67  1 × 1320x2868',
    ])
    // the messages table is smaller: no Apple TV size
    const tv = put(`${SHOTS}/iMessage/en-US/tv.png`, png(1920, 1080))
    expect(ios().problems).toEqual([`${tv}: 1920x1080 is not an iMessage screenshot size`])
  })

  test('a directory deliver gives no language is refused, with whatever sits beside it', () => {
    put(`${SHOTS}/en-US/01.png`, IPHONE())
    put(`${SHOTS}/default/01.png`, IPHONE())
    const r = ios()
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toStartWith(`${SHOTS}/default: deliver gives this directory no locale`)
    expect(r.files).toEqual([`${SHOTS}/en-US/01.png`])
    // a special name nested in an expandable one is loaded with no language too
    drop(`${SHOTS}/default`)
    put(`${SHOTS}/iMessage/default/01.png`, IPHONE())
    put(`${SHOTS}/appleTV/iMessage/01.png`, IPHONE())
    expect(ios().problems.map((p) => p.split(':')[0])).toEqual([
      `${SHOTS}/appleTV/iMessage`,
      `${SHOTS}/iMessage/default`,
    ])
  })

  test('a directory name deliver does not take is refused', () => {
    put(`${SHOTS}/en-US/01.png`, IPHONE())
    put(`${SHOTS}/en/01.png`, IPHONE())
    put(`${SHOTS}/raw/x.txt`, 'x')
    const r = ios()
    expect(r.problems.map((p) => p.split(':')[0])).toEqual([`${SHOTS}/en`, `${SHOTS}/raw`])
    expect(r.problems[0]).toContain('deliver does not take this directory name')
    expect(r.images.map((i) => i.file)).toEqual([`${SHOTS}/en-US/01.png`])
  })

  test('deliver’s language list, in any case; the locale reported is deliver’s spelling', () => {
    expect(DELIVER_LANGUAGES).toHaveLength(50)
    for (const name of ['zh-Hans', 'no', 'EN-us', 'APPLETV/pt-br']) put(`${SHOTS}/${name}/01.png`, IPHONE())
    const r = ios()
    expect(r.problems).toEqual([])
    expect(imageLocales(r.images).sort()).toEqual(['en-US', 'no', 'pt-BR', 'zh-Hans'])
  })

  test('what deliver never uploads is neither checked nor counted', () => {
    const shot = put(`${SHOTS}/en-US/01.png`, IPHONE())
    // frameit's layout: root files and fonts/; supply's android/; deliver's metadata dirs
    put(`${SHOTS}/background.png`, png(100, 100, true))
    put(`${SHOTS}/fonts/x.png`, png(100, 100, true))
    put(`${SHOTS}/Fonts/y.png`, 'x')
    put(`${SHOTS}/android/en-US/images/icon.png`, png(512, 512, true))
    put(`${SHOTS}/review_information/a.png`, 'x')
    // deeper than <locale>/, a dot file, another extension
    put(`${SHOTS}/en-US/raw/a.png`, png(100, 100))
    put(`${SHOTS}/en-US/.hidden.png`, 'x')
    put(`${SHOTS}/en-US/notes.txt`, 'x')
    // an unnamed directory inside appleTV|iMessage is dropped without an error
    put(`${SHOTS}/iMessage/en/a.png`, 'x')
    const r = ios()
    expect(r.problems).toEqual([])
    expect(r.files).toEqual([shot])
    expect(listingImageFiles('ios', join(root, SHOTS)).files).toEqual([
      { path: join(root, shot), locale: 'en-US', type: '' },
    ])
  })

  test('framed mode: with one *_framed file a locale sends only its framed and watch files', () => {
    put(`${SHOTS}/en-US/01.png`, png(100, 100, true))
    const framed = put(`${SHOTS}/en-US/01_framed.png`, IPHONE())
    const watch = put(`${SHOTS}/en-US/Watch-01.png`, png(416, 496))
    // another locale has no framed file: all of it goes up
    const fr = put(`${SHOTS}/fr-FR/01.png`, IPHONE())
    const r = ios()
    expect(r.problems).toEqual([])
    expect(r.files).toEqual([framed, watch, fr])
    expect(imageSummary(r.images)).toEqual([
      'en-US  APP_IPHONE_67  1 × 1320x2868',
      'en-US  APP_WATCH_SERIES_10  1 × 416x496',
      'fr-FR  APP_IPHONE_67  1 × 1320x2868',
    ])
  })
})

describe('checkListingImages: Play', () => {
  const shot = (name: string, w: number, h: number, type = 'phoneScreenshots') =>
    put(`${PLAY}/en-US/images/${type}/${name}`, png(w, h))

  test('screenshot sides are 320 to 3840', () => {
    const small = shot('1.png', 300, 500)
    const big = shot('2.png', 2000, 3900)
    shot('3.png', 320, 640)
    shot('4.png', 1920, 3840)
    expect(android().problems).toEqual([
      `${small}: 300x500: each side must be at least 320 px`,
      `${big}: 2000x3900: each side must be at most 3840 px`,
    ])
  })

  test('the long side is at most twice the short side', () => {
    const tall = shot('1.png', 1344, 2992)
    const wide = shot('2.png', 2992, 1344, 'tenInchScreenshots')
    shot('3.png', 1440, 2560)
    expect(android().problems).toEqual([
      `${tall}: 1344x2992: the long side must be at most 2x the short side`,
      `${wide}: 2992x1344: the long side must be at most 2x the short side`,
    ])
  })

  test('at most 8 per type and locale', () => {
    const bytes = png(1440, 2560)
    const files = Array.from({ length: 9 }, (_, i) =>
      put(`${PLAY}/en-US/images/phoneScreenshots/${i + 1}.png`, bytes),
    )
    put(`${PLAY}/en-US/images/sevenInchScreenshots/1.png`, bytes)
    const r = android()
    expect(r.problems).toEqual([
      `${files[8]}: the 9th phoneScreenshots image of en-US; the store keeps at most 8`,
    ])
    expect(r.images.at(-1)).toMatchObject({ locale: 'en-US', class: 'sevenInchScreenshots' })
  })

  test('fewer than 2 phone screenshots is a warning, not a problem', () => {
    // no phone screenshots at all: supply leaves the store's alone
    put(`${PLAY}/en-US/images/icon.png`, png(512, 512))
    expect(android().warnings).toEqual([])
    shot('1.png', 1440, 2560)
    const r = android()
    expect(r.problems).toEqual([])
    expect(r.warnings).toEqual(['en-US: 1 phone screenshot; Google Play asks for at least 2'])
    shot('2.png', 1440, 2560)
    expect(android().warnings).toEqual([])
  })

  test('featureGraphic is exactly 1024x500 and opaque', () => {
    const good = put(`${PLAY}/en-US/images/featureGraphic.png`, png(1024, 500))
    expect(android()).toEqual({
      files: [good],
      images: [{ file: good, locale: 'en-US', class: 'featureGraphic', width: 1024, height: 500 }],
      problems: [],
      warnings: [],
    })
    const bad = put(`${PLAY}/de-DE/images/featureGraphic.png`, png(1024, 512, true))
    expect(android().problems).toEqual([
      `${bad}: has an alpha channel; the store takes opaque images only`,
      `${bad}: 1024x512; the feature graphic must be 1024x500`,
    ])
  })

  test('icon is 512x512, at most 1024 KB, and may carry alpha', () => {
    put(`${PLAY}/en-US/images/icon.png`, png(512, 512, true))
    expect(android().problems).toEqual([])
    const wrong = put(`${PLAY}/de-DE/images/icon.png`, png(256, 256))
    expect(android().problems).toEqual([`${wrong}: 256x256; the icon must be 512x512`])
    drop(wrong)
    // a valid 512x512 PNG padded past the limit: the reader stops at IEND
    put(`${PLAY}/fr-FR/images/icon.png`, Buffer.concat([png(512, 512), new Uint8Array(1024 * 1024)]))
    expect(android().problems).toEqual([
      expect.stringMatching(/icon\.png: \d+ KB; the icon must be at most 1024 KB$/),
    ])
  })

  test('tvBanner is exactly 1280x720', () => {
    const banner = put(`${PLAY}/en-US/images/tvBanner.png`, png(1280, 720))
    expect(android()).toEqual({
      files: [banner],
      images: [{ file: banner, locale: 'en-US', class: 'tvBanner', width: 1280, height: 720 }],
      problems: [],
      warnings: [],
    })
    const bad = put(`${PLAY}/de-DE/images/tvBanner.png`, png(1024, 500))
    expect(android().problems).toEqual([`${bad}: 1024x500; the TV banner must be 1280x720`])
  })

  test('what supply never uploads is neither checked nor counted', () => {
    const icon = put(`${PLAY}/en-US/images/icon.png`, png(512, 512))
    const one = shot('1.png', 1440, 2560)
    const two = shot('2.JPG', 1440, 2560)
    // not one of supply's types; deeper than <type>/; outside images/; no locale directory
    put(`${PLAY}/en-US/images/promoGraphic.png`, png(180, 120, true))
    put(`${PLAY}/en-US/images/phoneScreenshots/raw/a.png`, png(100, 100, true))
    put(`${PLAY}/en-US/images/drafts/a.png`, 'x')
    put(`${PLAY}/en-US/icon.png`, 'x')
    put(`${PLAY}/icon.png`, 'x')
    const r = android()
    expect(r.problems).toEqual([`${two}: a PNG image named .jpg`])
    expect(r.files).toEqual([icon, one, two])
    expect(r.images.map((i) => i.class)).toEqual(['icon', 'phoneScreenshots', 'phoneScreenshots'])
  })

  test('supply’s order: featureGraphic, icon, tvBanner, then the screenshot types; one file per image type', () => {
    const wear = shot('1.png', 400, 400, 'wearScreenshots')
    const phone = shot('1.png', 1440, 2560)
    const banner = put(`${PLAY}/en-US/images/tvBanner.png`, png(1280, 720))
    const icon = put(`${PLAY}/en-US/images/icon.png`, png(512, 512))
    // of icon.jpg and icon.png, supply uploads the last
    put(`${PLAY}/en-US/images/icon.jpg`, 'x')
    const feature = put(`${PLAY}/en-US/images/featureGraphic.png`, png(1024, 500))
    const r = android()
    expect(r.files).toEqual([feature, icon, banner, phone, wear])
    expect(r.problems).toEqual([])
  })
})

describe('the confirmation card', () => {
  const images = [
    { file: 'a', locale: 'en-US', class: 'APP_IPHONE_67', width: 1320, height: 2868 },
    { file: 'b', locale: 'en-US', class: 'APP_IPHONE_67', width: 1290, height: 2796 },
    { file: 'c', locale: 'en-US', class: 'APP_IPAD_PRO_3GEN_129', width: 2064, height: 2752 },
    { file: 'd', locale: 'fr-FR', class: 'APP_IPHONE_67', width: 1320, height: 2868 },
  ]

  test('one line per locale and class: count and size', () => {
    expect(imageSummary(images)).toEqual([
      'en-US  APP_IPHONE_67  2 × 1320x2868, 1290x2796',
      'en-US  APP_IPAD_PRO_3GEN_129  1 × 2064x2752',
      'fr-FR  APP_IPHONE_67  1 × 1320x2868',
    ])
  })

  test('the locales in the push, once each', () => {
    expect(imageLocales(images)).toEqual(['en-US', 'fr-FR'])
  })
})
