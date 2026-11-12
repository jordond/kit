import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { ExitCode, KitError } from '../../src/lib/errors'
import { dirtyUnder, metadataDirs, metadataPlatform, pushPlan } from '../../src/lib/release/metadata'

const ios = { bundleIds: ['app.example'], project: 'ios/App.xcodeproj', scheme: 'App', output: 'App.ipa' }
const android = { packageName: 'app.example', module: ':android' }

const parse = (release: Record<string, unknown>) => configSchema.parse({ name: 'X', release })

let root: string
const put = (path: string, body = 'x') => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-metadata-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function thrown(fn: () => unknown): KitError {
  try {
    fn()
  } catch (e) {
    if (e instanceof KitError) return e
    throw e
  }
  throw new Error('did not throw')
}

describe('release.<platform>.metadata', () => {
  test('is an optional path on both platforms', () => {
    const c = parse({
      ios: { ...ios, metadata: 'fastlane/metadata' },
      android: { ...android, metadata: 'fastlane/metadata/android' },
    })
    expect(c.release?.ios?.metadata).toBe('fastlane/metadata')
    expect(c.release?.android?.metadata).toBe('fastlane/metadata/android')
    expect(parse({ ios, android }).release?.ios?.metadata).toBeUndefined()
  })

  test('values only: a non-string is rejected', () => {
    expect(() => parse({ ios: { ...ios, metadata: { dir: 'x' } } })).toThrow()
    expect(() => parse({ android: { ...android, metadata: 1 } })).toThrow()
  })

  test('metadataDirs resolves against the root; iOS screenshots sit next to the metadata dir', () => {
    const c = parse({
      ios: { ...ios, metadata: 'client/fastlane/metadata' },
      android: { ...android, metadata: 'client/fastlane/metadata/android' },
    })
    expect(metadataDirs('/repo', c, 'ios')).toEqual({
      dir: '/repo/client/fastlane/metadata',
      screenshotsDir: '/repo/client/fastlane/screenshots',
    })
    expect(metadataDirs('/repo', c, 'android')).toEqual({ dir: '/repo/client/fastlane/metadata/android' })
  })

  test('missing key is a usage error naming it', () => {
    const e = thrown(() => metadataDirs('/repo', parse({ ios }), 'ios'))
    expect(e.message).toBe('No release.ios.metadata in kit.config.ts')
    expect(e.exitCode).toBe(ExitCode.usage)
    const none = thrown(() => metadataDirs('/repo', configSchema.parse({ name: 'X' }), 'android'))
    expect(none.message).toContain('release.android.metadata')
    expect(none.exitCode).toBe(ExitCode.usage)
  })

  test('metadataPlatform accepts ios and android only', () => {
    expect(metadataPlatform('push', 'ios')).toBe('ios')
    expect(metadataPlatform('pull', 'android')).toBe('android')
    expect(thrown(() => metadataPlatform('push', undefined)).exitCode).toBe(ExitCode.usage)
    expect(thrown(() => metadataPlatform('pull', 'web')).message).toContain('(got "web")')
  })
})

describe('pushPlan', () => {
  test('iOS: every .txt under the metadata dir except supply’s android/, screenshots only when asked', () => {
    put('fastlane/metadata/en-US/name.txt')
    put('fastlane/metadata/en-US/description.txt')
    put('fastlane/metadata/fr-FR/name.txt')
    put('fastlane/metadata/copyright.txt')
    put('fastlane/metadata/review_information/notes.txt')
    put('fastlane/metadata/android/en-US/title.txt')
    put('fastlane/metadata/.DS_Store')
    put('fastlane/metadata/en-US/notes.md')
    put('fastlane/screenshots/en-US/0_APP_IPHONE_67_0.png')
    put('fastlane/screenshots/en-US/1_APP_IPHONE_67_1.JPG')
    put('fastlane/screenshots/README.txt')
    const dirs = metadataDirs(
      root,
      parse({ ios: { ...ios, metadata: 'fastlane/metadata' } }),
      'ios',
    )
    const text = [
      'fastlane/metadata/copyright.txt',
      'fastlane/metadata/en-US/description.txt',
      'fastlane/metadata/en-US/name.txt',
      'fastlane/metadata/fr-FR/name.txt',
      'fastlane/metadata/review_information/notes.txt',
    ]
    expect(pushPlan(root, 'ios', dirs, false)).toEqual({ text, images: [], files: text })
    const images = [
      'fastlane/screenshots/en-US/0_APP_IPHONE_67_0.png',
      'fastlane/screenshots/en-US/1_APP_IPHONE_67_1.JPG',
    ]
    expect(pushPlan(root, 'ios', dirs, true)).toEqual({ text, images, files: [...text, ...images] })
  })

  test('Android: the four listing fields per locale, never changelogs; images only when asked', () => {
    put('store/en-US/title.txt')
    put('store/en-US/short_description.txt')
    put('store/en-US/full_description.txt')
    put('store/en-US/video.txt')
    put('store/en-US/changelogs/42.txt')
    put('store/en-US/changelogs/default.txt')
    put('store/en-US/images/icon.png')
    put('store/en-US/images/featureGraphic.jpeg')
    put('store/en-US/images/phoneScreenshots/1_en-US.png')
    put('store/de-DE/title.txt')
    put('store/README.txt')
    const dirs = metadataDirs(root, parse({ android: { ...android, metadata: 'store' } }), 'android')
    const text = [
      'store/de-DE/title.txt',
      'store/en-US/title.txt',
      'store/en-US/short_description.txt',
      'store/en-US/full_description.txt',
      'store/en-US/video.txt',
    ]
    expect(pushPlan(root, 'android', dirs, false)).toEqual({ text, images: [], files: text })
    expect(pushPlan(root, 'android', dirs, true).images).toEqual([
      'store/en-US/images/featureGraphic.jpeg',
      'store/en-US/images/icon.png',
      'store/en-US/images/phoneScreenshots/1_en-US.png',
    ])
  })

  test('a missing directory plans nothing', () => {
    const dirs = metadataDirs(root, parse({ android: { ...android, metadata: 'nope' } }), 'android')
    expect(pushPlan(root, 'android', dirs, true).files).toEqual([])
  })
})

describe('dirtyUnder', () => {
  test('outside a git repo every existing file counts', async () => {
    put('store/en-US/title.txt')
    expect(await dirtyUnder(root, [join(root, 'store'), join(root, 'absent')])).toEqual([
      '?? store/en-US/title.txt',
    ])
  })
})
