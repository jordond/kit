import { describe, expect, test } from 'bun:test'
import {
  addSlide,
  hasOverride,
  moveSlide,
  type Place,
  projectFromShots,
  promoteField,
  readField,
  removeSlide,
  resetField,
  setContent,
  setLocaleText,
  setShot,
  sourceOf,
  writeField,
} from '../../editor/src/scope'
import { resolveSlides } from '../../src/lib/storeshots/resolve'
import type { ProjectV2 } from '../../src/lib/storeshots/types'

const TARGETS = ['ios', 'ipad', 'android'] as const
const place = (slide = 0, target: Place['target'] = 'ios'): Place => ({ target, slide, targets: TARGETS })
const scale = { section: 'device', key: 'scale' } as const
const colour = { section: 'headline', key: 'color' } as const

const base = (): ProjectV2 => ({
  version: 2,
  slides: [
    { shot: '01-you.png', headline: 'You' },
    { shot: '02-map.png', headline: 'Map' },
  ],
})

describe('reading a field and where it comes from', () => {
  test('built-in when nothing sets it', () => {
    expect(readField(base(), place(), scale)).toEqual({ value: 0.76, source: 'built-in' })
  })

  test('each layer wins over the ones below it', () => {
    let p = base()
    p = writeField(p, 'all', place(), scale, 0.9)
    expect(sourceOf(p, place(), scale)).toBe('project')
    p = writeField(p, 'target', place(), scale, 0.8)
    expect(readField(p, place(), scale)).toEqual({ value: 0.8, source: 'target' })
    expect(readField(p, place(0, 'ipad'), scale)).toEqual({ value: 0.9, source: 'project' })
    p = writeField(p, 'slide', place(), scale, 0.7)
    expect(readField(p, place(), scale)).toEqual({ value: 0.7, source: 'slide' })
    expect(readField(p, place(1), scale)).toEqual({ value: 0.8, source: 'target' })
    p = writeField(p, 'slide-target', place(), scale, 0.6)
    expect(readField(p, place(), scale)).toEqual({ value: 0.6, source: 'slide-target' })
    expect(readField(p, place(0, 'android'), scale)).toEqual({ value: 0.7, source: 'slide' })
  })

  test('a field with no built-in value reads as undefined', () => {
    expect(readField(base(), place(), { section: 'device', key: 'frameType' }).value).toBeUndefined()
  })
})

describe('writing at a scope', () => {
  test('All slides writes the project style and nothing else', () => {
    const p = writeField(base(), 'all', place(), scale, 0.9)
    expect(p.style).toEqual({ device: { scale: 0.9 } })
    expect(p.targets).toBeUndefined()
    expect(p.slides).toEqual(base().slides)
  })

  test('This target writes targets[target]', () => {
    const p = writeField(base(), 'target', place(0, 'ipad'), scale, 0.5)
    expect(p.targets).toEqual({ ipad: { device: { scale: 0.5 } } })
    expect(p.style).toBeUndefined()
  })

  test('This slide writes that slide only', () => {
    const p = writeField(base(), 'slide', place(1), colour, '#ff0000')
    expect(p.slides[1]!.style).toEqual({ headline: { color: '#ff0000' } })
    expect(p.slides[0]!.style).toBeUndefined()
  })

  test('This slide on this target writes slide.targets[target]', () => {
    const p = writeField(base(), 'slide-target', place(0, 'android'), scale, 0.5)
    expect(p.slides[0]!.targets).toEqual({ android: { device: { scale: 0.5 } } })
  })

  test('the written rules resolve as the layers say', () => {
    let p = writeField(base(), 'all', place(), scale, 0.9)
    p = writeField(p, 'slide-target', place(1, 'ipad'), scale, 0.5)
    expect(resolveSlides(p, 'ipad').map((s) => s.device.scale)).toEqual([0.9, 0.5])
    expect(resolveSlides(p, 'ios').map((s) => s.device.scale)).toEqual([0.9, 0.9])
  })

  test('does not change the project it is given', () => {
    const before = base()
    const copy = structuredClone(before)
    writeField(before, 'slide', place(), scale, 0.5)
    expect(before).toEqual(copy)
  })
})

describe('the minimal-file rule', () => {
  test('a value equal to the built-in removes the project override and prunes', () => {
    let p = writeField(base(), 'all', place(), scale, 0.9)
    p = writeField(p, 'all', place(), scale, 0.76)
    expect(p).toEqual(base())
    expect('style' in p).toBe(false)
  })

  test('writing the built-in value at All slides adds nothing', () => {
    expect(writeField(base(), 'all', place(), scale, 0.76)).toEqual(base())
  })

  test('a slide value equal to the project value is removed, and the empty slide.style is dropped', () => {
    let p = writeField(base(), 'all', place(), scale, 0.9)
    p = writeField(p, 'slide', place(), scale, 0.5)
    p = writeField(p, 'slide', place(), scale, 0.9)
    expect('style' in p.slides[0]!).toBe(false)
    expect(p.style).toEqual({ device: { scale: 0.9 } })
  })

  test('a target value equal to the project value is removed and targets is dropped', () => {
    let p = writeField(base(), 'all', place(), scale, 0.9)
    p = writeField(p, 'target', place(), scale, 0.5)
    p = writeField(p, 'target', place(), scale, 0.9)
    expect('targets' in p).toBe(false)
  })

  test('a slide-target value equal to what the target gives is removed with its empty objects', () => {
    let p = writeField(base(), 'target', place(0, 'ipad'), scale, 0.5)
    p = writeField(p, 'slide-target', place(0, 'ipad'), scale, 0.3)
    p = writeField(p, 'slide-target', place(0, 'ipad'), scale, 0.5)
    expect('targets' in p.slides[0]!).toBe(false)
  })

  test('a slide value that equals the base on this target but not on another stays', () => {
    const p0 = writeField(base(), 'target', place(0, 'ipad'), scale, 0.5)
    // On ipad the base is 0.5, on ios it is 0.76: the slide override still matters on ios.
    const p = writeField(p0, 'slide', place(0, 'ipad'), scale, 0.5)
    expect(p.slides[0]!.style).toEqual({ device: { scale: 0.5 } })
  })

  test('other fields of a section survive when one is removed', () => {
    let p = writeField(base(), 'all', place(), scale, 0.9)
    p = writeField(p, 'all', place(), { section: 'device', key: 'yOffset' }, 8)
    p = writeField(p, 'all', place(), scale, 0.76)
    expect(p.style).toEqual({ device: { yOffset: 8 } })
  })
})

describe('reset', () => {
  test('removes the override at the scope and the value falls back', () => {
    let p = writeField(base(), 'all', place(), scale, 0.9)
    p = writeField(p, 'slide', place(), scale, 0.5)
    expect(hasOverride(p, 'slide', place(), scale)).toBe(true)
    p = resetField(p, 'slide', place(), scale)
    expect(hasOverride(p, 'slide', place(), scale)).toBe(false)
    expect(readField(p, place(), scale)).toEqual({ value: 0.9, source: 'project' })
    expect('style' in p.slides[0]!).toBe(false)
  })

  test('resetting what is not set changes nothing', () => {
    expect(resetField(base(), 'target', place(), scale)).toEqual(base())
  })
})

describe('promote', () => {
  test('moves the slide override to All slides', () => {
    let p = writeField(base(), 'slide', place(1), colour, '#ff0000')
    p = promoteField(p, place(1), colour)
    expect(p.style).toEqual({ headline: { color: '#ff0000' } })
    expect('style' in p.slides[1]!).toBe(false)
    expect(sourceOf(p, place(0), colour)).toBe('project')
  })

  test('a slide with no override is left alone', () => {
    expect(promoteField(base(), place(), colour)).toEqual(base())
  })

  test('another slide that overrides the same field keeps its own value', () => {
    let p = writeField(base(), 'slide', place(0), colour, '#ff0000')
    p = writeField(p, 'slide', place(1), colour, '#00ff00')
    p = promoteField(p, place(0), colour)
    expect(readField(p, place(1), colour)).toEqual({ value: '#00ff00', source: 'slide' })
  })
})

describe('content fields are the slide own', () => {
  test('headline, subheadline, badge and name are set on the slide', () => {
    let p = setContent(base(), 0, 'headline', 'Hello')
    p = setContent(p, 0, 'subheadline', 'Sub')
    p = setContent(p, 0, 'badge', 'NEW')
    p = setContent(p, 0, 'name', 'first')
    expect(p.slides[0]).toEqual({
      shot: '01-you.png',
      headline: 'Hello',
      subheadline: 'Sub',
      badge: 'NEW',
      name: 'first',
    })
    expect(p.style).toBeUndefined()
    expect(p.slides[1]).toEqual(base().slides[1]!)
  })

  test('empty text removes an optional field but a headline stays', () => {
    let p = setContent(base(), 0, 'subheadline', 'Sub')
    p = setContent(p, 0, 'subheadline', '')
    p = setContent(p, 0, 'headline', '')
    expect(p.slides[0]).toEqual({ shot: '01-you.png', headline: '' })
  })

  test('locale text is set, pruned when emptied, and the locales key dropped', () => {
    let p = setLocaleText(base(), 'fr', 'you', 'headline', 'Toi')
    expect(p.locales).toEqual({ fr: { you: { headline: 'Toi' } } })
    p = setLocaleText(p, 'fr', 'you', 'subheadline', 'Sous')
    p = setLocaleText(p, 'fr', 'you', 'headline', '')
    expect(p.locales).toEqual({ fr: { you: { subheadline: 'Sous' } } })
    p = setLocaleText(p, 'fr', 'you', 'subheadline', '')
    expect('locales' in p).toBe(false)
  })

  test('a shot change re-keys the locale text, or keeps the id when the new one is taken', () => {
    let p = setLocaleText(base(), 'fr', 'you', 'headline', 'Toi')
    p = setShot(p, 0, '01-me.png')
    expect(p.locales).toEqual({ fr: { me: { headline: 'Toi' } } })

    const q = setShot(setLocaleText(base(), 'fr', 'you', 'headline', 'Toi'), 0, '03-map.png')
    expect(q.slides[0]).toEqual({ shot: '03-map.png', headline: 'You', id: 'you' })
    expect(q.locales).toEqual({ fr: { you: { headline: 'Toi' } } })
  })
})

describe('slides', () => {
  test('add takes a raw shot, never a clone of another slide', () => {
    const styled = writeField(base(), 'slide', place(), scale, 0.5)
    const p = addSlide(styled, '03-new-thing.png')
    expect(p.slides[2]).toEqual({ shot: '03-new-thing.png', headline: 'New thing' })
  })

  test('add gives a slide an explicit id when its derived id is taken', () => {
    const p = addSlide(base(), '09-you.png')
    expect(p.slides[2]).toEqual({ shot: '09-you.png', headline: 'You', id: 'you-2' })
  })

  test('remove drops the slide and its locale text', () => {
    let p = setLocaleText(base(), 'fr', 'map', 'headline', 'Carte')
    p = removeSlide(p, 1)
    expect(p.slides.map((s) => s.shot)).toEqual(['01-you.png'])
    expect('locales' in p).toBe(false)
  })

  test('move reorders by array position', () => {
    const p = moveSlide(base(), 0, 1)
    expect(p.slides.map((s) => s.shot)).toEqual(['02-map.png', '01-you.png'])
    expect(moveSlide(base(), 0, 5)).toEqual(base())
  })

  test('a new project has one slide per raw shot in file order', () => {
    const p = projectFromShots(['10-b.png', '02-a.png', '02-a.png'])
    expect(p.slides.map((s) => s.shot)).toEqual(['02-a.png', '10-b.png'])
    expect(p.version).toBe(2)
    expect('style' in p).toBe(false)
  })
})
