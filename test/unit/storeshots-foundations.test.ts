import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { findChrome } from '../../src/lib/chrome'
import { KitError } from '../../src/lib/errors'
import {
  APPLE_SET_CLASS,
  APPLE_SIZES,
  appleClass,
  parseStores,
  playProblems,
  resolveSets,
  SET_SIZES,
} from '../../src/lib/storeshots/sizes'
import { type ExportPlan, pagePlan, type Slide } from '../../src/lib/storeshots/types'

describe('shots config', () => {
  const maestro = { dir: 'maestro' }

  test('accepts the full block', () => {
    const config = configSchema.parse({
      name: 'app',
      maestro,
      shots: {
        project: 'brand/studio.json',
        fonts: [{ family: 'Nunito', file: 'brand/fonts/nunito.woff2', weight: '400 800' }],
        brand: { mark: 'brand/logo.svg', wordmark: 'app', color: '#46291B', font: 'Nunito' },
        sets: { ios: 'iphone-6.5' },
      },
    })
    expect(resolveSets(config)).toEqual({ ios: 'iphone-6.5', ipad: 'ipad-13', android: 'phone' })
  })

  test('presets are style rules under the strict schema, palette hex colours as a list or a map', () => {
    const parse = (shots: object) =>
      configSchema.safeParse({ name: 'app', maestro, shots: { project: 'p', ...shots } })
    const ok = parse({
      presets: {
        sand: { background: { primaryColor: '#f4ecd8' }, headline: { color: '#2c1e14', fontWeight: 700 } },
      },
      palette: ['#fff', '#2c1e14', '#11223344'],
    })
    expect(ok.success).toBe(true)
    expect(parse({ palette: { ink: '#2c1e14', paper: '#f4ecd8' } }).success).toBe(true)
    // A key the project's style does not have is refused in a preset too, with its path.
    const unknown = parse({ presets: { sand: { background: { primaryColour: '#fff' } } } })
    expect(unknown.success).toBe(false)
    expect(unknown.error?.issues[0]?.path.slice(0, 4)).toEqual(['shots', 'presets', 'sand', 'background'])
    expect(parse({ presets: { sand: { headline: { fontSize: 'big' } } } }).success).toBe(false)
    expect(parse({ presets: { '': {} } }).success).toBe(false)
    expect(parse({ palette: ['red'] }).success).toBe(false)
    expect(parse({ palette: { ink: 'not-a-colour' } }).success).toBe(false)
  })

  test('without a maestro block, shots needs raw', () => {
    const r = configSchema.safeParse({ name: 'app', shots: { project: 'studio.json' } })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]).toMatchObject({ path: ['shots', 'raw'] })
    expect(
      configSchema.safeParse({ name: 'app', shots: { project: 'studio.json', raw: 'shots' } }).success,
    ).toBe(true)
  })

  test('rejects an unknown set and an unknown key', () => {
    const base = { name: 'app', maestro }
    expect(
      configSchema.safeParse({ ...base, shots: { project: 'p', sets: { ios: 'iphone-5.5' } } }).success,
    ).toBe(false)
    expect(configSchema.safeParse({ ...base, shots: { project: 'p', logo: 'x' } }).success).toBe(false)
  })

  test('shots.pages is HTML artwork pages: a project is optional, the rest is checked', () => {
    const page = { name: 'header', file: 'art/header.html', width: 3840, height: 1646 }
    const parse = (shots: object) => configSchema.safeParse({ name: 'app', maestro, shots })
    expect(parse({ pages: [page] }).success).toBe(true)
    expect(
      parse({ project: 'p', pages: [{ ...page, scale: 1, background: '#fff', out: 'build/h.png' }] }).success,
    ).toBe(true)
    // Neither a project nor pages.
    expect(parse({}).success).toBe(false)
    // The old store-listing shape (no name) and unknown keys.
    expect(parse({ pages: [{ file: 'a.html', out: 'm.png', width: 1024, height: 500 }] }).success).toBe(false)
    expect(parse({ pages: [{ ...page, extra: 1 }] }).success).toBe(false)
    // Duplicate names, a size that is not a multiple of the scale, an alpha or bad background.
    expect(parse({ pages: [page, page] }).error?.issues[0]).toMatchObject({
      path: ['shots', 'pages', 1, 'name'],
    })
    expect(parse({ pages: [{ ...page, width: 3841 }] }).error?.issues[0]).toMatchObject({
      path: ['shots', 'pages', 0, 'width'],
    })
    expect(parse({ pages: [{ ...page, background: '#11223344' }] }).success).toBe(false)
    expect(parse({ pages: [{ ...page, background: 'red' }] }).success).toBe(false)
    expect(parse({ pages: [{ ...page, name: '../x' }] }).success).toBe(false)
  })

  test('font weights go into CSS, so only words and numbers pass', () => {
    const fonts = (weight: string) => ({ project: 'p', fonts: [{ family: 'F', file: 'f.ttf', weight }] })
    expect(configSchema.safeParse({ name: 'app', maestro, shots: fonts('400 800') }).success).toBe(true)
    expect(configSchema.safeParse({ name: 'app', maestro, shots: fonts('400; } body { x') }).success).toBe(
      false,
    )
  })
})

describe('sizes', () => {
  test('every Apple set is a size App Store Connect takes, in the class kit names', () => {
    for (const [set, cls] of Object.entries(APPLE_SET_CLASS)) {
      const { width, height } = SET_SIZES[set as keyof typeof APPLE_SET_CLASS]
      expect(appleClass(width, height)).toBe(cls)
    }
    expect(resolveSets({})).toEqual({ ios: 'iphone-6.9', ipad: 'ipad-13', android: 'phone' })
  })

  test('appleClass reads the size, both orientations, and nothing else', () => {
    expect(appleClass(1320, 2868)).toBe('APP_IPHONE_67')
    expect(appleClass(2868, 1320)).toBe('APP_IPHONE_67')
    expect(appleClass(2064, 2752)).toBe('APP_IPAD_PRO_3GEN_129')
    expect(appleClass(1344, 2992)).toBeUndefined()
    expect(appleClass(1440, 2560)).toBeUndefined()
    // In the table one way round only.
    expect(appleClass(640, 1096)).toBe('APP_IPHONE_40')
    expect(appleClass(1096, 640)).toBeUndefined()
  })

  test('a size in two classes follows the path, as deliver does', () => {
    expect(appleClass(2048, 2732)).toBe('APP_IPAD_PRO_3GEN_129')
    expect(appleClass(2048, 2732, 'screenshots/en-US/01_APP_IPAD_PRO_129.png')).toBe('APP_IPAD_PRO_129')
    expect(appleClass(3840, 2160)).toBe('APP_APPLE_TV')
    expect(appleClass(3840, 2160, 'screenshots/en-US/vision-01.png')).toBe('APP_APPLE_VISION_PRO')
  })

  test('a file in iMessage/<locale>/ gets an iMessage class, from the smaller messages table', () => {
    const at = (name: string) => `/repo/fastlane/screenshots/iMessage/en-US/${name}`
    expect(appleClass(1320, 2868, at('01.png'))).toBe('IMESSAGE_APP_IPHONE_67')
    expect(appleClass(750, 1334, at('01.png'))).toBe('IMESSAGE_APP_IPHONE_47')
    expect(appleClass(2064, 2752, 'iMessage/en-US/01.png')).toBe('IMESSAGE_APP_IPAD_PRO_3GEN_129')
    expect(appleClass(2048, 2732, at('01.png'))).toBe('IMESSAGE_APP_IPAD_PRO_3GEN_129')
    expect(appleClass(2048, 2732, at('01_APP_IPAD_PRO_129.png'))).toBe('IMESSAGE_APP_IPAD_PRO_129')
    // sizes the messages table lacks: 3.5", Duo, Mac, Watch, Apple TV, Vision Pro
    for (const [w, h] of [
      [640, 960],
      [1398, 2034],
      [1280, 800],
      [416, 496],
      [1920, 1080],
      [3840, 2160],
    ]) {
      expect(appleClass(w!, h!, at('01.png'))).toBeUndefined()
      expect(appleClass(w!, h!, '/repo/fastlane/screenshots/en-US/01.png')).toBeDefined()
    }
    // deliver compares the third component from the end with "iMessage", exactly
    expect(appleClass(1320, 2868, '/repo/screenshots/imessage/en-US/01.png')).toBe('APP_IPHONE_67')
    expect(appleClass(1320, 2868, '/repo/iMessage/screenshots/en-US/01.png')).toBe('APP_IPHONE_67')
    expect(appleClass(1320, 2868, '/repo/screenshots/en-US/iMessage.png')).toBe('APP_IPHONE_67')
    expect(appleClass(1320, 2868)).toBe('APP_IPHONE_67')
  })

  test('the table has no size listed twice within a class', () => {
    for (const sizes of Object.values(APPLE_SIZES)) {
      const keys = sizes.map(([w, h]) => `${w}x${h}`)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  test('playProblems: sides 320 to 3840, long side at most twice the short', () => {
    expect(playProblems(1440, 2560)).toEqual([])
    expect(playProblems(1080, 2160)).toEqual([])
    expect(playProblems(320, 640)).toEqual([])
    expect(playProblems(1344, 2992)).toEqual(['1344x2992: the long side must be at most 2x the short side'])
    expect(playProblems(2992, 1344)).toHaveLength(1)
    expect(playProblems(300, 500)).toEqual(['300x500: each side must be at least 320 px'])
    expect(playProblems(2160, 4000)).toEqual(['2160x4000: each side must be at most 3840 px'])
    expect(playProblems(100, 4000)).toHaveLength(3)
  })

  test('parseStores', () => {
    expect(parseStores(undefined)).toEqual(['apple', 'google'])
    expect(parseStores('both')).toEqual(['apple', 'google'])
    expect(parseStores('google')).toEqual(['google'])
    let error: unknown
    try {
      parseStores('apple,google')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(KitError)
    expect((error as KitError).exitCode).toBe(2)
  })
})

describe('findChrome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-chrome-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const bin = (name: string): string => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    const file = join(dir, 'bin', name)
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
    return file
  }

  test('KIT_CHROME wins over CHROME_PATH, and both over what is installed', () => {
    const mine = bin('my-chrome')
    const other = bin('other-chrome')
    expect(findChrome({ KIT_CHROME: mine, CHROME_PATH: other, PATH: '' })).toBe(mine)
    expect(findChrome({ CHROME_PATH: other, PATH: '' })).toBe(other)
  })

  test('a set variable that names nothing gives undefined: no fallback', () => {
    bin('chromium')
    const env = { KIT_CHROME: join(dir, 'nope'), PATH: join(dir, 'bin'), HOME: dir }
    expect(findChrome(env)).toBeUndefined()
  })

  test('a bare command name in the variable is looked up on PATH', () => {
    const file = bin('chrome-beta')
    expect(findChrome({ KIT_CHROME: 'chrome-beta', PATH: join(dir, 'bin') })).toBe(file)
  })

  // The macOS app bundles come before PATH, so the PATH names are only observable elsewhere.
  test.skipIf(process.platform === 'darwin')('falls back to the PATH names in order', () => {
    const chromium = bin('chromium')
    expect(findChrome({ PATH: join(dir, 'bin'), HOME: dir })).toBe(chromium)
    const chrome = bin('google-chrome')
    expect(findChrome({ PATH: join(dir, 'bin'), HOME: dir })).toBe(chrome)
    expect(findChrome({ PATH: join(dir, 'empty'), HOME: dir })).toBeUndefined()
  })
})

test('pagePlan keeps what the page needs and writes an absent brand as null', () => {
  const slide = { id: 's1', name: 'Home' } as Slide
  const plan: ExportPlan = {
    stores: ['apple'],
    destinations: [{ store: 'apple', dir: '/repo/meta/screenshots', locales: ['en-US'] }],
    jobs: [
      {
        id: 'ios-en-US-01',
        store: 'apple',
        target: 'ios',
        set: 'iphone-6.9',
        locale: 'en-US',
        index: 1,
        width: 1320,
        height: 2868,
        slide,
        shot: '/repo/raw/ios/home.png',
        file: '/repo/meta/screenshots/en-US/01_iphone-6.9_home.png',
      },
    ],
    skipped: [],
    fonts: [{ family: 'Nunito', url: 'asset/0' }],
    assets: ['/repo/brand/nunito.woff2'],
  }
  expect(pagePlan(plan)).toEqual({
    fonts: [{ family: 'Nunito', url: 'asset/0' }],
    brand: null,
    jobs: [{ id: 'ios-en-US-01', width: 1320, height: 2868, slide }],
  })
})
