import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { ExitCode, KitError } from '../../src/lib/errors'
import { encodePng } from '../../src/lib/image/png'
import { planExport } from '../../src/lib/storeshots/plan'
import { parseProject } from '../../src/lib/storeshots/project'
import {
  type ExportPlan,
  MANIFEST_FILE,
  type PlanInput,
  type ShotsManifest,
  type StoreDestination,
} from '../../src/lib/storeshots/types'
import { writeExport } from '../../src/lib/storeshots/write'
import fixtureConfig from '../fixtures/shots-app/kit.config'

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'shots-app')
const config = configSchema.parse(fixtureConfig)
const project = parseProject(JSON.parse(readFileSync(join(FIXTURE, 'brand', 'studio.json'), 'utf8')))
const RAW = new Set(['ios', 'ipad', 'android'].flatMap((t) => [`${t}/home.png`, `${t}/journal.png`]))

/** A black PNG of this size: what sits in a store dir, as deliver and kit classify it. */
const png = (width: number, height: number) => encodePng(width, height, new Uint8Array(width * height * 3))
const IPHONE_69 = png(1320, 2868)
const IPHONE_67 = png(1290, 2796)
const IPHONE_65 = png(1284, 2778)
const IPAD_13 = png(2064, 2752)
const PHONE = png(1440, 2560)

let root: string
let appleDir: string
let googleDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-shots-write-'))
  appleDir = join(root, 'fastlane', 'screenshots')
  googleDir = join(root, 'fastlane', 'metadata', 'android')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const put = (path: string, body: Uint8Array | string = 'x') => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), body)
}
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(join(root, path)))

/** Every file under the root, relative, sorted. */
const tree = (): string[] =>
  (readdirSync(root, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort()

const manifest = (dir: string): ShotsManifest => JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))

const apple = (locales = ['en-US']): StoreDestination => ({ store: 'apple', dir: appleDir, locales })
const google = (locales = ['en-US']): StoreDestination => ({ store: 'google', dir: googleDir, locales })

const plan = (destinations: StoreDestination[], over: Partial<PlanInput> = {}): ExportPlan =>
  planExport({
    root,
    config,
    project,
    destinations,
    rawDir: join(root, 'maestro', 'screenshots'),
    raw: RAW,
    allowMissing: false,
    ...over,
  })

/** One distinct image per job, so a test can tell which job a file came from. */
const render = (p: ExportPlan): Map<string, Uint8Array> =>
  new Map(p.jobs.map((job, i) => [job.id, encodePng(1, 1, new Uint8Array([i, i, i]))]))

const write = (p: ExportPlan, opts: { force?: boolean } = {}) =>
  writeExport(p, { root, images: render(p), force: opts.force ?? false, dryRun: false })

async function rejected(promise: Promise<unknown>): Promise<KitError> {
  try {
    await promise
  } catch (e) {
    if (e instanceof KitError) return e
    throw e
  }
  throw new Error('did not throw')
}

const APPLE_EN = [
  'fastlane/screenshots/en-US/01_iphone-6.9_1-home.png',
  'fastlane/screenshots/en-US/02_iphone-6.9_2-journal.png',
  'fastlane/screenshots/en-US/01_ipad-13_1-home.png',
  'fastlane/screenshots/en-US/02_ipad-13_2-journal.png',
]
const GOOGLE_EN = [
  'fastlane/metadata/android/en-US/images/phoneScreenshots/01_1-home.png',
  'fastlane/metadata/android/en-US/images/phoneScreenshots/02_2-journal.png',
]

describe('writeExport', () => {
  test('writes every job and one manifest per store dir', async () => {
    const p = plan([apple(), google()])
    const images = render(p)
    const result = await writeExport(p, { root, images, force: false, dryRun: false })

    expect(result.removed).toEqual([])
    expect(result.written.map((w) => w.file)).toEqual([...APPLE_EN, ...GOOGLE_EN])
    expect(result.written[0]).toEqual({
      store: 'apple',
      target: 'ios',
      set: 'iphone-6.9',
      locale: 'en-US',
      slide: 'slide-1',
      file: APPLE_EN[0]!,
      width: 1320,
      height: 2868,
    })
    expect(tree()).toEqual(
      [
        ...APPLE_EN,
        ...GOOGLE_EN,
        `fastlane/screenshots/${MANIFEST_FILE}`,
        `fastlane/metadata/android/${MANIFEST_FILE}`,
      ].sort(),
    )
    for (const job of p.jobs) expect(read(relative(root, job.file))).toEqual(images.get(job.id)!)
    expect(manifest(appleDir)).toEqual({
      version: 1,
      files: [
        'en-US/01_ipad-13_1-home.png',
        'en-US/01_iphone-6.9_1-home.png',
        'en-US/02_ipad-13_2-journal.png',
        'en-US/02_iphone-6.9_2-journal.png',
      ],
    })
    expect(manifest(googleDir)).toEqual({
      version: 1,
      files: [
        'en-US/images/phoneScreenshots/01_1-home.png',
        'en-US/images/phoneScreenshots/02_2-journal.png',
      ],
    })
  })

  test('a second export replaces its own files and leaves no temp files', async () => {
    await write(plan([apple(), google()]))
    const result = await write(plan([apple(), google()]))
    expect(result.removed).toEqual([])
    expect(tree().filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(manifest(googleDir).files).toHaveLength(2)
  })

  test('removes the files of the last export that this one no longer writes', async () => {
    await write(plan([apple(), google()]))
    const renamed = {
      ...project,
      slides: [{ ...project.slides[0]!, name: 'Welcome' }],
      locales: undefined,
    }
    const result = await write(plan([apple(), google()], { project: renamed }))

    expect(result.removed).toEqual([...APPLE_EN, ...GOOGLE_EN].sort())
    expect(tree().filter((f) => f.endsWith('.png'))).toEqual([
      'fastlane/metadata/android/en-US/images/phoneScreenshots/01_welcome.png',
      'fastlane/screenshots/en-US/01_ipad-13_welcome.png',
      'fastlane/screenshots/en-US/01_iphone-6.9_welcome.png',
    ])
    expect(manifest(appleDir).files).toEqual([
      'en-US/01_ipad-13_welcome.png',
      'en-US/01_iphone-6.9_welcome.png',
    ])
    expect(manifest(googleDir).files).toEqual(['en-US/images/phoneScreenshots/01_welcome.png'])
  })

  test('a set that is not exported this time keeps its files and its place in the manifest', async () => {
    await write(plan([apple(['en-US', 'fr-FR']), google(['en-US', 'fr-FR'])]))
    const before = tree()
    // Only the French Play set, with one slide: the English set and the App Store are not its business.
    const one = { ...project, slides: [project.slides[1]!] }
    const result = await write(plan([google(['fr-FR'])], { project: one }))

    expect(result.removed).toEqual([
      'fastlane/metadata/android/fr-FR/images/phoneScreenshots/01_1-home.png',
      'fastlane/metadata/android/fr-FR/images/phoneScreenshots/02_2-journal.png',
    ])
    expect(manifest(googleDir).files).toEqual([
      'en-US/images/phoneScreenshots/01_1-home.png',
      'en-US/images/phoneScreenshots/02_2-journal.png',
      'fr-FR/images/phoneScreenshots/01_2-journal.png',
    ])
    expect(tree().filter((f) => f.startsWith('fastlane/screenshots/'))).toEqual(
      before.filter((f) => f.startsWith('fastlane/screenshots/')),
    )
  })

  test('changing the set of a target removes the files of the old set', async () => {
    await write(plan([apple()]))
    const smaller = { ...config, shots: { ...config.shots!, sets: { ios: 'iphone-6.5' as const } } }
    const result = await write(plan([apple()], { config: smaller }))
    expect(result.removed).toEqual([APPLE_EN[0]!, APPLE_EN[1]!].sort())
    expect(manifest(appleDir).files).toEqual([
      'en-US/01_ipad-13_1-home.png',
      'en-US/01_iphone-6.5_1-home.png',
      'en-US/02_ipad-13_2-journal.png',
      'en-US/02_iphone-6.5_2-journal.png',
    ])
  })

  test('refuses when an image it did not write sits in a set it exports, listing every one', async () => {
    put('fastlane/screenshots/en-US/hand-made.png', IPHONE_67)
    put('fastlane/screenshots/en-US/tablet.png', IPAD_13)
    put('fastlane/metadata/android/en-US/images/phoneScreenshots/old.jpg', 'not even an image')
    const before = tree()

    const e = await rejected(write(plan([apple(), google()])))
    expect(e.exitCode).toBe(ExitCode.precondition)
    expect(e.message).toBe(
      [
        '3 images kit shots export did not write are in the way:',
        '  fastlane/screenshots/en-US/hand-made.png',
        '  fastlane/screenshots/en-US/tablet.png',
        '  fastlane/metadata/android/en-US/images/phoneScreenshots/old.jpg',
      ].join('\n'),
    )
    expect(e.hint).toContain('--force')
    expect(tree()).toEqual(before)
  })

  test('an App Store image of another display type, locale or kind is not in the way', async () => {
    put('fastlane/screenshots/en-US/small-phone.png', IPHONE_65)
    put('fastlane/screenshots/en-US/notes.txt', 'keep')
    put('fastlane/screenshots/en-US/.hidden.png', IPHONE_69)
    put('fastlane/screenshots/de-DE/phone.png', IPHONE_69)
    const result = await write(plan([apple()]))
    expect(result.removed).toEqual([])
    expect(read('fastlane/screenshots/en-US/small-phone.png')).toEqual(IPHONE_65)
    expect(read('fastlane/screenshots/de-DE/phone.png')).toEqual(IPHONE_69)
    expect(existsSync(join(root, 'fastlane/screenshots/en-US/notes.txt'))).toBe(true)
    expect(existsSync(join(root, 'fastlane/screenshots/en-US/.hidden.png'))).toBe(true)
    expect(manifest(appleDir).files).not.toContain('en-US/small-phone.png')
  })

  test('an unlisted file at a path the export writes is in the way, whatever it is', async () => {
    put(APPLE_EN[0]!, 'someone else put this here')
    const e = await rejected(write(plan([apple()])))
    expect(e.exitCode).toBe(ExitCode.precondition)
    expect(e.message).toBe(`1 image kit shots export did not write is in the way:\n  ${APPLE_EN[0]}`)
    expect(readFileSync(join(root, APPLE_EN[0]!), 'utf8')).toBe('someone else put this here')
  })

  test('--force replaces the images in the way and lists them as removed', async () => {
    put('fastlane/screenshots/en-US/hand-made.png', IPHONE_69)
    put('fastlane/screenshots/en-US/small-phone.png', IPHONE_65)
    put('fastlane/metadata/android/en-US/images/phoneScreenshots/old.png', PHONE)
    put(GOOGLE_EN[0]!, PHONE)
    const result = await write(plan([apple(), google()]), { force: true })

    expect(result.removed).toEqual([
      'fastlane/metadata/android/en-US/images/phoneScreenshots/old.png',
      'fastlane/screenshots/en-US/hand-made.png',
    ])
    expect(tree().filter((f) => f.endsWith('.png'))).toEqual(
      [...APPLE_EN, ...GOOGLE_EN, 'fastlane/screenshots/en-US/small-phone.png'].sort(),
    )
    expect(read(GOOGLE_EN[0]!)).not.toEqual(PHONE)
    expect(manifest(googleDir).files).toHaveLength(2)
  })

  test('a dry run reports what would be written and removed and touches nothing', async () => {
    await write(plan([apple(), google()]))
    put('fastlane/metadata/android/en-US/images/phoneScreenshots/old.png', PHONE)
    const before = tree()
    const bytes = before.map((f) => read(f))
    const one = { ...project, slides: [project.slides[1]!] }
    const p = plan([apple(), google()], { project: one })

    const e = await rejected(writeExport(p, { root, force: false, dryRun: true }))
    expect(e.exitCode).toBe(ExitCode.precondition)

    const result = await writeExport(p, { root, force: true, dryRun: true })
    expect(result.written.map((w) => w.file)).toEqual([
      'fastlane/screenshots/en-US/01_iphone-6.9_2-journal.png',
      'fastlane/screenshots/en-US/01_ipad-13_2-journal.png',
      'fastlane/metadata/android/en-US/images/phoneScreenshots/01_2-journal.png',
    ])
    expect(result.removed).toEqual(
      [...APPLE_EN, ...GOOGLE_EN, 'fastlane/metadata/android/en-US/images/phoneScreenshots/old.png'].sort(),
    )
    expect(tree()).toEqual(before)
    expect(before.map((f) => read(f))).toEqual(bytes)
  })

  test('a dry run into an empty dir creates nothing', async () => {
    const result = await writeExport(plan([apple(), google()]), { root, force: false, dryRun: true })
    expect(result.written).toHaveLength(6)
    expect(result.removed).toEqual([])
    expect(tree()).toEqual([])
  })

  test("never touches Play's icon, feature graphic or other screenshot types", async () => {
    const others = [
      'fastlane/metadata/android/en-US/images/icon.png',
      'fastlane/metadata/android/en-US/images/featureGraphic.png',
      'fastlane/metadata/android/en-US/images/tenInchScreenshots/01.png',
      'fastlane/metadata/android/en-US/images/sevenInchScreenshots/01.png',
      'fastlane/metadata/android/en-US/title.txt',
    ]
    for (const file of others) put(file, file)
    // Even a manifest that claims them (hand-edited, or from a kit that owned more) changes nothing.
    put(
      `fastlane/metadata/android/${MANIFEST_FILE}`,
      JSON.stringify({
        version: 1,
        files: ['en-US/images/icon.png', 'en-US/images/tenInchScreenshots/01.png', '../../../kit.config.ts'],
      }),
    )
    put('kit.config.ts', 'export default {}')

    const result = await write(plan([google()]), { force: true })
    expect(result.removed).toEqual([])
    for (const file of others) expect(readFileSync(join(root, file), 'utf8')).toBe(file)
    expect(existsSync(join(root, 'kit.config.ts'))).toBe(true)
    expect(manifest(googleDir).files).toEqual([
      'en-US/images/icon.png',
      'en-US/images/phoneScreenshots/01_1-home.png',
      'en-US/images/phoneScreenshots/02_2-journal.png',
      'en-US/images/tenInchScreenshots/01.png',
    ])
  })

  test('a manifest that cannot be read stops the export; --force starts over', async () => {
    put(`fastlane/screenshots/${MANIFEST_FILE}`, '{ "version": 2 }')
    const e = await rejected(write(plan([apple()])))
    expect(e.exitCode).toBe(ExitCode.precondition)
    expect(e.message).toContain(MANIFEST_FILE)
    await write(plan([apple()]), { force: true })
    expect(manifest(appleDir).files).toHaveLength(4)
  })

  test('a job without a rendered image fails before anything is written', async () => {
    const p = plan([apple()])
    const images = render(p)
    images.delete('ipad-en-US-02')
    const e = await rejected(writeExport(p, { root, images, force: false, dryRun: false }))
    expect(e.exitCode).toBe(ExitCode.failed)
    expect(e.message).toContain('ipad-en-US-02')
    expect(tree()).toEqual([])
  })

  test('--out outside the repo: result paths are absolute', async () => {
    const out = mkdtempSync(join(tmpdir(), 'kit-shots-out-'))
    try {
      const p = plan([{ store: 'google', dir: join(out, 'google'), locales: ['en-US'] }])
      const result = await write(p)
      expect(result.written.map((w) => w.file)).toEqual(p.jobs.map((j) => j.file))
      expect(existsSync(join(out, 'google', MANIFEST_FILE))).toBe(true)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
