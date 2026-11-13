import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExitCode, KitError } from '../../src/lib/errors'
import { migrateChecked, migrateProject, roundTripDiffs } from '../../src/lib/storeshots/migrate'
import { parseProject } from '../../src/lib/storeshots/project'
import type { ProjectV1, ProjectV2 } from '../../src/lib/storeshots/types'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')
const read = (...parts: string[]): ProjectV1 =>
  parseProject(JSON.parse(readFileSync(join(FIXTURES, ...parts), 'utf8'))) as ProjectV1

const shotsApp = () => read('shots-app', 'brand', 'studio.json')
const brewd = () => read('brewd-studio.json')

/** A copy of `project` with `change` applied to each slide, by index. */
function edit(project: ProjectV1, change: (slide: ProjectV1['slides'][0], index: number) => void): ProjectV1 {
  const copy = structuredClone(project)
  copy.slides.forEach(change)
  return copy
}

describe('migrateProject', () => {
  test('the fixture project migrates, round-trips and parses as version 2', () => {
    const v1 = shotsApp()
    const v2 = migrateProject(v1)
    expect(roundTripDiffs(v1, v2)).toEqual([])
    expect(parseProject(v2)).toEqual(v2)
    expect(v2.slides.map((s) => s.shot)).toEqual(['home.png', 'journal.png'])
  })

  test('the committed version 2 copy of the fixture is what migrate writes', () => {
    const committed = JSON.parse(readFileSync(join(FIXTURES, 'shots-app', 'brand', 'studio.v2.json'), 'utf8'))
    expect(migrateProject(shotsApp())).toEqual(committed)
  })

  test("brewd's real project round-trips to one style and bare slides", () => {
    const v1 = brewd()
    const v2 = migrateChecked(v1)
    expect(roundTripDiffs(v1, v2)).toEqual([])
    // Every slide shares one layout, so nothing is left per slide but its words and file.
    for (const slide of v2.slides) expect(slide.style).toBeUndefined()
    expect(v2.slides.map((s) => s.shot)).toEqual(v1.slides.map((s) => s.sourceFile))
    expect(v2.style?.device).toMatchObject({ position: 'full-bleed', scale: 0.85, yOffset: 6 })
    // Values the built-in style has are left out.
    expect(v2.style?.headline).not.toHaveProperty('fontWeight')
    expect(v2.style?.background).not.toHaveProperty('type')
    expect(JSON.stringify(v2).length).toBeLessThan(JSON.stringify(v1).length / 5)
  })

  test('a field that differs on every slide stays on every slide', () => {
    const v1 = edit(shotsApp(), (s, i) => {
      s.device.scale = 0.5 + i / 10
    })
    const v2 = migrateProject(v1)
    // Two slides, two values: the first is the project's, the other carries its own.
    expect(v2.slides.map((s) => s.style?.device?.scale)).toEqual([undefined, 0.6])
    expect(v2.style?.device?.scale).toBe(0.5)
    expect(roundTripDiffs(v1, v2)).toEqual([])
  })

  test('the value most slides share is the style; the others keep theirs', () => {
    const base = brewd()
    const v1 = edit(base, (s, i) => {
      s.headline.color = i === 2 ? '#ff0000' : '#00aa00'
    })
    const v2 = migrateProject(v1)
    expect(v2.style?.headline?.color).toBe('#00aa00')
    expect(v2.slides.map((s) => s.style?.headline?.color)).toEqual([
      undefined,
      undefined,
      '#ff0000',
      undefined,
      undefined,
      undefined,
    ])
    expect(roundTripDiffs(v1, v2)).toEqual([])
  })

  test('a slide that sets a built-in value against a different shared one keeps it', () => {
    const v1 = edit(brewd(), (s, i) => {
      s.background.type = i === 0 ? 'linear-gradient' : 'solid'
    })
    const v2 = migrateProject(v1)
    expect(v2.style?.background?.type).toBe('solid')
    expect(v2.slides[0]?.style?.background?.type).toBe('linear-gradient')
    expect(roundTripDiffs(v1, v2)).toEqual([])
  })

  test("badge text: the shared one is the style, another is the slide's own", () => {
    const v1 = edit(shotsApp(), (s, i) => {
      s.badge.enabled = true
      s.badge.text = i === 1 ? 'ONLY HERE' : 'SHARED'
    })
    const v2 = migrateProject(v1)
    expect(v2.style?.badge?.text).toBe('SHARED')
    expect(v2.slides.map((s) => s.badge)).toEqual([undefined, 'ONLY HERE'])
    expect(roundTripDiffs(v1, v2)).toEqual([])
  })

  test('slides go in order, and locales follow the derived ids', () => {
    const v1 = edit(shotsApp(), (s, i) => {
      s.order = 5 - i
    })
    const v2 = migrateProject(v1)
    expect(v2.slides.map((s) => s.shot)).toEqual(['journal.png', 'home.png'])
    expect(Object.keys(v2.locales?.['fr-FR'] ?? {}).sort()).toEqual(['home', 'journal'])
    expect(roundTripDiffs(v1, v2)).toEqual([])
  })

  test('two shots that derive one id keep their own ids', () => {
    const v1 = edit(shotsApp(), (s, i) => {
      s.sourceFile = `0${i + 1}-same.png`
    })
    const v2 = migrateProject(v1)
    expect(v2.slides.map((s) => s.id)).toEqual(['slide-1', 'slide-2'])
    expect(parseProject(v2)).toEqual(v2)
    expect(roundTripDiffs(v1, v2)).toEqual([])
  })

  test('angled-3d becomes bottom-peek, as it was drawn', () => {
    const v1 = edit(shotsApp(), (s) => {
      s.device.position = 'angled-3d'
    })
    const v2 = migrateProject(v1)
    expect(v2.style?.device?.position).toBeUndefined()
    expect(roundTripDiffs(v1, v2)).toEqual([])
  })

  test('a frame that is not a platform frame is kept on every slide that has it', () => {
    const v1 = edit(shotsApp(), (s) => {
      s.device.frameType = 'glass-card'
      s.device.cornerRadius = 30
    })
    const v2 = migrateProject(v1)
    expect(v2.style?.device).toMatchObject({ frameType: 'glass-card', cornerRadius: 30 })
    expect(roundTripDiffs(v1, v2)).toEqual([])
  })

  test('the target frame is derived, so a frame set against it is a named difference', () => {
    const v1 = edit(shotsApp(), (s) => {
      s.device.cornerRadius = 20
    })
    const diffs = roundTripDiffs(v1, migrateProject(v1))
    expect(diffs.length).toBeGreaterThan(0)
    expect(diffs[0]).toMatch(/^slide slide-1 ipad device\.cornerRadius: 24 -> 20$/)
    try {
      migrateChecked(v1)
      throw new Error('did not throw')
    } catch (e) {
      expect(e).toBeInstanceOf(KitError)
      expect((e as KitError).exitCode).toBe(ExitCode.precondition)
      expect((e as KitError).message).toContain('slide slide-1 ipad device.cornerRadius')
    }
  })

  test('a changed migration is caught by the proof, with its locale', () => {
    const v1 = shotsApp()
    const v2: ProjectV2 = migrateProject(v1)
    v2.locales = { 'fr-FR': { home: { headline: 'Autre' }, journal: {} } }
    expect(roundTripDiffs(v1, v2).some((d) => d.includes('slide slide-1 ios fr-FR headline.text'))).toBe(true)
  })
})
