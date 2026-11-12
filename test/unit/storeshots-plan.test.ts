import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { configSchema, type KitConfig } from '../../src/config/schema'
import { ExitCode, KitError } from '../../src/lib/errors'
import { planExport, slideForTarget, slideSlug } from '../../src/lib/storeshots/plan'
import { parseProject } from '../../src/lib/storeshots/project'
import type { PlanInput, StoreDestination } from '../../src/lib/storeshots/types'
import fixtureConfig from '../fixtures/shots-app/kit.config'

const ROOT = join(import.meta.dir, '..', 'fixtures', 'shots-app')
const RAW = join(ROOT, 'maestro', 'screenshots')
const APPLE = join(ROOT, 'fastlane', 'screenshots')
const GOOGLE = join(ROOT, 'fastlane', 'metadata', 'android')

const config = configSchema.parse(fixtureConfig)
const project = parseProject(JSON.parse(readFileSync(join(ROOT, 'brand', 'studio.json'), 'utf8')))

/** The raw listing as `exportShots` passes it: every file under the raw dir, relative, `/`-separated. */
const listing = (): Set<string> =>
  new Set(
    (readdirSync(RAW, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
      .filter((e) => e.isFile())
      .map((e) => relative(RAW, join(e.parentPath, e.name)).split('\\').join('/')),
  )

const apple = (locales = ['en-US', 'fr-FR'], dir = APPLE): StoreDestination => ({
  store: 'apple',
  dir,
  locales,
})
const google = (locales = ['en-US', 'fr-FR'], dir = GOOGLE): StoreDestination => ({
  store: 'google',
  dir,
  locales,
})

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  root: ROOT,
  config,
  project,
  destinations: [apple(), google()],
  rawDir: RAW,
  raw: listing(),
  allowMissing: false,
  ...over,
})

function thrown(fn: () => unknown): KitError {
  try {
    fn()
  } catch (e) {
    if (e instanceof KitError) return e
    throw e
  }
  throw new Error('did not throw')
}

describe('planExport', () => {
  test('one job per slide, set and locale, ordered by store, target, locale, index', () => {
    const plan = planExport(input())
    expect(plan.stores).toEqual(['apple', 'google'])
    expect(plan.destinations).toEqual([apple(), google()])
    expect(plan.skipped).toEqual([])
    expect(plan.jobs.map((j) => j.id)).toEqual([
      'ios-en-US-01',
      'ios-en-US-02',
      'ios-fr-FR-01',
      'ios-fr-FR-02',
      'ipad-en-US-01',
      'ipad-en-US-02',
      'ipad-fr-FR-01',
      'ipad-fr-FR-02',
      'android-en-US-01',
      'android-en-US-02',
      'android-fr-FR-01',
      'android-fr-FR-02',
    ])
    expect(new Set(plan.jobs.map((j) => j.id)).size).toBe(plan.jobs.length)
    for (const job of plan.jobs) expect(job.id).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  test('each target is exported at the size of its set', () => {
    const byTarget = (jobs: ReturnType<typeof planExport>['jobs']) =>
      Object.fromEntries(jobs.map((j) => [j.target, [j.store, j.set, j.width, j.height]]))
    expect(byTarget(planExport(input()).jobs)).toEqual({
      ios: ['apple', 'iphone-6.9', 1320, 2868],
      ipad: ['apple', 'ipad-13', 2064, 2752],
      android: ['google', 'phone', 1440, 2560],
    })
    const smaller: KitConfig = { ...config, shots: { ...config.shots!, sets: { ios: 'iphone-6.5' } } }
    const jobs = planExport(input({ config: smaller, destinations: [apple(['en-US'])] })).jobs
    expect(byTarget(jobs).ios).toEqual(['apple', 'iphone-6.5', 1284, 2778])
    expect(jobs[0]?.file).toBe(join(APPLE, 'en-US', '01_iphone-6.5_1-home.png'))
  })

  test('only the stores and locales of the destinations are planned', () => {
    const plan = planExport(input({ destinations: [google(['fr-FR'])] }))
    expect(plan.stores).toEqual(['google'])
    expect(plan.jobs.map((j) => j.id)).toEqual(['android-fr-FR-01', 'android-fr-FR-02'])
  })

  test('files land in the store listing dirs', () => {
    const files = planExport(input({ destinations: [apple(['en-US']), google(['en-US'])] })).jobs.map(
      (j) => j.file,
    )
    expect(files).toEqual([
      join(APPLE, 'en-US', '01_iphone-6.9_1-home.png'),
      join(APPLE, 'en-US', '02_iphone-6.9_2-journal.png'),
      join(APPLE, 'en-US', '01_ipad-13_1-home.png'),
      join(APPLE, 'en-US', '02_ipad-13_2-journal.png'),
      join(GOOGLE, 'en-US', 'images', 'phoneScreenshots', '01_1-home.png'),
      join(GOOGLE, 'en-US', 'images', 'phoneScreenshots', '02_2-journal.png'),
    ])
  })

  test('--out: the same layout under <out>/apple and <out>/google', () => {
    const out = join(ROOT, 'build', 'store-shots')
    const plan = planExport(
      input({ destinations: [apple(['fr-FR'], join(out, 'apple')), google(['fr-FR'], join(out, 'google'))] }),
    )
    expect(plan.jobs.map((j) => relative(out, j.file).split('\\').join('/'))).toEqual([
      'apple/fr-FR/01_iphone-6.9_1-home.png',
      'apple/fr-FR/02_iphone-6.9_2-journal.png',
      'apple/fr-FR/01_ipad-13_1-home.png',
      'apple/fr-FR/02_ipad-13_2-journal.png',
      'google/fr-FR/images/phoneScreenshots/01_1-home.png',
      'google/fr-FR/images/phoneScreenshots/02_2-journal.png',
    ])
  })

  test('slides are exported in order; ties keep file order', () => {
    const [a, b] = project.slides
    const slides = [
      { ...b!, id: 'late', order: 5, name: 'Late' },
      { ...a!, id: 'tie-1', order: 2, name: 'Tie one' },
      { ...a!, id: 'tie-2', order: 2, name: 'Tie two' },
      { ...a!, id: 'early', order: -1, name: 'Early' },
    ]
    const jobs = planExport(
      input({ project: { ...project, slides, locales: undefined }, destinations: [google(['en-US'])] }),
    ).jobs
    expect(jobs.map((j) => [j.index, j.slide.id])).toEqual([
      [1, 'early'],
      [2, 'tie-1'],
      [3, 'tie-2'],
      [4, 'late'],
    ])
    expect(jobs[3]?.file).toEndWith('04_late.png')
  })

  test('the slug comes from the slide name, or the id when the name has nothing to give', () => {
    expect(slideSlug({ id: 'slide-1', name: '1 - you ' })).toBe('1-you')
    expect(slideSlug({ id: 'slide-1', name: '  Café & Crème!  ' })).toBe('caf-cr-me')
    expect(slideSlug({ id: 'slide-1', name: 'Home_Screen.v2' })).toBe('home-screen-v2')
    expect(slideSlug({ id: 'Slide 7', name: '———' })).toBe('slide-7')
    expect(slideSlug({ id: 'slide-1', name: '' })).toBe('slide-1')
  })

  test('text is localised: exact locale, then base text', () => {
    const jobs = planExport(input({ destinations: [google()] })).jobs
    const text = (id: string) => {
      const slide = jobs.find((j) => j.id === id)!.slide
      return [slide.headline.text, slide.subheadline.text, slide.badge.text]
    }
    expect(text('android-en-US-01')).toEqual(['Everything in one place', 'Your day at a glance', 'NEW'])
    expect(text('android-fr-FR-01')).toEqual([
      'Tout au même endroit',
      "Votre journée en un coup d'œil",
      'NOUVEAU',
    ])
    expect(text('android-fr-FR-02')).toEqual(['Souvenez-vous de vos coups de cœur', '', 'NEW'])
  })

  test('text falls back to another locale of the same language', () => {
    const jobs = planExport(input({ destinations: [google(['fr-CA', 'de-DE'])] })).jobs
    expect(jobs.map((j) => j.slide.headline.text)).toEqual([
      'Tout au même endroit',
      'Souvenez-vous de vos coups de cœur',
      'Everything in one place',
      'Remember what you loved',
    ])
  })

  test('a raw shot is the locale one when it exists, else the shared one', () => {
    const shots = Object.fromEntries(planExport(input()).jobs.map((j) => [j.id, relative(RAW, j.shot)]))
    expect(shots['ios-en-US-01']).toBe(join('ios', 'home.png'))
    expect(shots['ios-fr-FR-01']).toBe(join('ios', 'fr-FR', 'home.png'))
    expect(shots['ios-fr-FR-02']).toBe(join('ios', 'journal.png'))
    expect(shots['ipad-fr-FR-01']).toBe(join('ipad', 'home.png'))
    expect(shots['android-fr-FR-01']).toBe(join('android', 'home.png'))
  })

  test('a missing raw shot fails, listing every missing file once', () => {
    const raw = listing()
    raw.delete('ipad/home.png')
    raw.delete('android/journal.png')
    const e = thrown(() => planExport(input({ raw })))
    expect(e.exitCode).toBe(ExitCode.precondition)
    expect(e.message).toBe(
      '2 raw shots are missing:\n  maestro/screenshots/ipad/home.png\n  maestro/screenshots/android/journal.png',
    )
    expect(e.hint).toContain('kit shots ipad')
    expect(e.hint).toContain('kit shots android')
    expect(e.hint).toContain('--allow-missing')
  })

  test('a shot taken for one locale only does not stand in for the others', () => {
    const raw = listing()
    raw.delete('ios/home.png')
    const e = thrown(() => planExport(input({ raw, destinations: [apple()] })))
    expect(e.message).toBe('1 raw shot is missing:\n  maestro/screenshots/ios/home.png')
    expect(
      planExport(input({ raw, destinations: [apple(['fr-FR'])] })).jobs.filter((j) => j.target === 'ios'),
    ).toHaveLength(2)
  })

  test('--allow-missing skips the slide and closes the gap in the numbering', () => {
    const raw = listing()
    raw.delete('ipad/home.png')
    const plan = planExport(input({ raw, allowMissing: true, destinations: [apple(['en-US'])] }))
    expect(plan.skipped).toEqual([
      {
        store: 'apple',
        target: 'ipad',
        set: 'ipad-13',
        locale: 'en-US',
        slide: 'slide-1',
        shot: 'maestro/screenshots/ipad/home.png',
      },
    ])
    expect(plan.jobs.map((j) => [j.id, j.slide.id])).toEqual([
      ['ios-en-US-01', 'slide-1'],
      ['ios-en-US-02', 'slide-2'],
      ['ipad-en-US-01', 'slide-2'],
    ])
    expect(plan.jobs[2]?.file).toBe(join(APPLE, 'en-US', '01_ipad-13_2-journal.png'))
  })

  test('the frame follows the target when it was a device of its own', () => {
    const jobs = planExport(input({ destinations: [apple(['en-US']), google(['en-US'])] })).jobs
    const device = (id: string) => {
      const { platform, device } = jobs.find((j) => j.id === id)!.slide
      return [platform, device.frameType, device.cornerRadius]
    }
    expect(device('ios-en-US-01')).toEqual(['ios', 'iphone-pro', 56])
    expect(device('ipad-en-US-01')).toEqual(['ipad', 'ipad-pro', 24])
    expect(device('android-en-US-01')).toEqual(['android', 'android-pixel', 48])
    // A clay frame is a choice, not a device: it stays, with its own corner radius.
    expect(device('ios-en-US-02')).toEqual(['ios', 'clay-minimal', 40])
    expect(device('ipad-en-US-02')).toEqual(['ipad', 'clay-minimal', 40])
    expect(device('android-en-US-02')).toEqual(['android', 'clay-minimal', 40])
  })

  test('slideForTarget keeps the layout and returns the same slide for its own target', () => {
    const slide = project.slides[0]!
    expect(slideForTarget(slide, 'ios')).toBe(slide)
    const swapped = slideForTarget(slide, 'android')
    expect(swapped.device).toEqual({ ...slide.device, frameType: 'android-pixel', cornerRadius: 48 })
    expect({ ...swapped, platform: slide.platform, device: slide.device }).toEqual(slide)
    expect(slideForTarget({ ...slide, platform: 'android' }, 'ios').device.frameType).toBe('iphone-pro')
  })

  test('fonts and the brand mark become assets, fonts first', () => {
    const plan = planExport(input())
    expect(plan.assets).toEqual([
      join(ROOT, 'brand', 'fonts', 'fixture.ttf'),
      join(ROOT, 'brand', 'mark.svg'),
    ])
    expect(plan.fonts).toEqual([{ family: 'Kit Fixture', url: 'asset/0', weight: '400 800' }])
    expect(plan.brand).toEqual({ mark: 'asset/1', wordmark: 'shots', color: '#2c1e14', font: 'Kit Fixture' })
  })

  test('no fonts and no brand: no assets', () => {
    const bare: KitConfig = { ...config, shots: { project: 'brand/studio.json' } }
    const plan = planExport(input({ config: bare }))
    expect(plan.assets).toEqual([])
    expect(plan.fonts).toEqual([])
    expect(plan.brand).toBeUndefined()
    expect('brand' in plan).toBe(false)
  })

  test('a locale that is not a dir name is refused', () => {
    const e = thrown(() => planExport(input({ destinations: [google(['../en'])] })))
    expect(e.exitCode).toBe(ExitCode.usage)
  })

  test('the input is not changed', () => {
    const before = JSON.stringify(project)
    planExport(input())
    expect(JSON.stringify(project)).toBe(before)
  })
})
