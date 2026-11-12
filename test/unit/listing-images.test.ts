import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { encodePng } from '../../src/lib/image/png'
import { checkListingImages, imageLocales, imageSummary } from '../../src/lib/release/listing-images'

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

const SHOTS = 'fastlane/screenshots'
const PLAY = 'fastlane/metadata/android'
const ios = (files: string[]) => checkListingImages('ios', root, join(root, SHOTS), files)
const android = (files: string[]) => checkListingImages('android', root, join(root, PLAY), files)

describe('checkListingImages: both stores', () => {
  test('a clean set has no problems and reports each file', () => {
    const files = [
      put(`${SHOTS}/en-US/01_iphone.png`, png(1320, 2868)),
      put(`${SHOTS}/en-US/02_ipad.jpg`, jpeg(2064, 2752)),
      put(`${SHOTS}/fr-FR/01_iphone.JPEG`, jpeg(1320, 2868)),
    ]
    expect(ios(files)).toEqual({
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
    const b = put(`${SHOTS}/en-US/b.jpg`, png(1320, 2868))
    const r = ios([a, b])
    expect(r.problems).toEqual([`${a}: a JPEG image named .png`, `${b}: a PNG image named .jpg`])
    expect(r.images.map((i) => i.file)).toEqual([a, b])
  })

  test('a file that is no image is a problem and not in images', () => {
    const a = put(`${SHOTS}/en-US/a.png`, 'x')
    const r = ios([a, `${SHOTS}/en-US/gone.png`])
    expect(r.images).toEqual([])
    expect(r.problems[0]).toBe(`${a}: Not a PNG or JPEG image`)
    expect(r.problems[1]).toStartWith(`${SHOTS}/en-US/gone.png: `)
  })

  test('alpha is refused on both stores', () => {
    const a = put(`${SHOTS}/en-US/a.png`, png(1320, 2868, true))
    expect(ios([a]).problems).toEqual([`${a}: has an alpha channel; the store takes opaque images only`])
    const b = put(`${PLAY}/en-US/images/phoneScreenshots/1.png`, png(1440, 2560, true))
    const c = put(`${PLAY}/en-US/images/phoneScreenshots/2.png`, png(1440, 2560))
    expect(android([b, c]).problems).toEqual([
      `${b}: has an alpha channel; the store takes opaque images only`,
    ])
  })
})

describe('checkListingImages: iOS', () => {
  test('a size outside Apple’s table is a problem; orientation counts', () => {
    const a = put(`${SHOTS}/en-US/a.png`, png(1344, 2992))
    const b = put(`${SHOTS}/en-US/b.png`, png(2868, 1320))
    const r = ios([a, b])
    expect(r.problems).toEqual([`${a}: 1344x2992 is not an App Store screenshot size`])
    expect(r.images.map((i) => i.class)).toEqual(['unknown', 'APP_IPHONE_67'])
  })

  test('at most 10 per locale and class: each one past the tenth is named', () => {
    const shot = png(1320, 2868)
    const pad = png(2064, 2752)
    const files = Array.from({ length: 12 }, (_, i) =>
      put(`${SHOTS}/en-US/${String(i + 1).padStart(2, '0')}.png`, shot),
    )
    // other classes and locales have their own count
    const others = [put(`${SHOTS}/en-US/ipad.png`, pad), put(`${SHOTS}/de-DE/01.png`, shot)]
    expect(ios([...files, ...others]).problems).toEqual([
      `${files[10]}: the 11th APP_IPHONE_67 image of en-US; the store keeps at most 10`,
      `${files[11]}: the 12th APP_IPHONE_67 image of en-US; the store keeps at most 10`,
    ])
    expect(ios(files.slice(0, 10)).problems).toEqual([])
  })

  test('the locale of a nested deliver directory is the innermost one', () => {
    const a = put(`${SHOTS}/appleTV/en-US/a.png`, png(1920, 1080))
    expect(ios([a]).images).toEqual([
      { file: a, locale: 'en-US', class: 'APP_APPLE_TV', width: 1920, height: 1080 },
    ])
  })
})

describe('checkListingImages: Play', () => {
  const shot = (name: string, w: number, h: number, type = 'phoneScreenshots') =>
    put(`${PLAY}/en-US/images/${type}/${name}`, png(w, h))

  test('screenshot sides are 320 to 3840', () => {
    const small = shot('1.png', 300, 500)
    const big = shot('2.png', 2000, 3900)
    const edge = [shot('3.png', 320, 640), shot('4.png', 1920, 3840)]
    expect(android([small, big, ...edge]).problems).toEqual([
      `${small}: 300x500: each side must be at least 320 px`,
      `${big}: 2000x3900: each side must be at most 3840 px`,
    ])
  })

  test('the long side is at most twice the short side', () => {
    const tall = shot('1.png', 1344, 2992)
    const wide = shot('2.png', 2992, 1344, 'tenInchScreenshots')
    const ok = shot('3.png', 1440, 2560)
    expect(android([tall, ok, wide]).problems).toEqual([
      `${tall}: 1344x2992: the long side must be at most 2x the short side`,
      `${wide}: 2992x1344: the long side must be at most 2x the short side`,
    ])
  })

  test('at most 8 per type and locale', () => {
    const bytes = png(1440, 2560)
    const files = Array.from({ length: 9 }, (_, i) =>
      put(`${PLAY}/en-US/images/phoneScreenshots/${i + 1}.png`, bytes),
    )
    const tablet = put(`${PLAY}/en-US/images/sevenInchScreenshots/1.png`, bytes)
    const r = android([...files, tablet])
    expect(r.problems).toEqual([
      `${files[8]}: the 9th phoneScreenshots image of en-US; the store keeps at most 8`,
    ])
    expect(r.images.at(-1)).toMatchObject({ locale: 'en-US', class: 'sevenInchScreenshots' })
  })

  test('fewer than 2 phone screenshots is a warning, not a problem', () => {
    const one = shot('1.png', 1440, 2560)
    const r = android([one])
    expect(r.problems).toEqual([])
    expect(r.warnings).toEqual(['en-US: 1 phone screenshot; Google Play asks for at least 2'])
    expect(android([one, shot('2.png', 1440, 2560)]).warnings).toEqual([])
    // no phone screenshots at all: supply leaves the store's alone
    expect(android([put(`${PLAY}/en-US/images/icon.png`, png(512, 512))]).warnings).toEqual([])
  })

  test('featureGraphic is exactly 1024x500 and opaque', () => {
    const good = put(`${PLAY}/en-US/images/featureGraphic.png`, png(1024, 500))
    expect(android([good])).toEqual({
      images: [{ file: good, locale: 'en-US', class: 'featureGraphic', width: 1024, height: 500 }],
      problems: [],
      warnings: [],
    })
    const bad = put(`${PLAY}/de-DE/images/featureGraphic.png`, png(1024, 512, true))
    expect(android([bad]).problems).toEqual([
      `${bad}: has an alpha channel; the store takes opaque images only`,
      `${bad}: 1024x512; the feature graphic must be 1024x500`,
    ])
  })

  test('icon is 512x512, at most 1024 KB, and may carry alpha', () => {
    const good = put(`${PLAY}/en-US/images/icon.png`, png(512, 512, true))
    expect(android([good]).problems).toEqual([])
    const wrong = put(`${PLAY}/de-DE/images/icon.png`, png(256, 256))
    expect(android([wrong]).problems).toEqual([`${wrong}: 256x256; the icon must be 512x512`])
    // a valid 512x512 PNG padded past the limit: the reader stops at IEND
    const heavy = put(
      `${PLAY}/fr-FR/images/icon.png`,
      Buffer.concat([png(512, 512), new Uint8Array(1024 * 1024)]),
    )
    expect(android([heavy]).problems).toEqual([expect.stringMatching(/icon\.png: \d+ KB; the icon must be at most 1024 KB$/)])
  })

  test('the size rules of screenshots do not apply to other images', () => {
    const banner = put(`${PLAY}/en-US/images/tvBanner.png`, png(1280, 720))
    expect(android([banner])).toEqual({
      images: [{ file: banner, locale: 'en-US', class: 'tvBanner', width: 1280, height: 720 }],
      problems: [],
      warnings: [],
    })
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
