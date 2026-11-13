import { describe, expect, test } from 'bun:test'
import { parseProject } from '../../src/lib/storeshots/project'
import { BUILT_IN_STYLE, derivedId, resolveSlides, TARGET_FRAME } from '../../src/lib/storeshots/resolve'
import type { ProjectV2 } from '../../src/lib/storeshots/types'

const v2 = (extra: Partial<ProjectV2> = {}): ProjectV2 => ({
  version: 2,
  slides: [
    { shot: '01-you.png', headline: 'You' },
    { shot: '02-map.png', headline: 'Map', subheadline: 'On one map', badge: 'NEW' },
  ],
  ...extra,
})

const first = (project: ProjectV2, target: 'ios' | 'ipad' | 'android' = 'ios', index = 0) =>
  resolveSlides(project, target)[index]!

describe('resolveSlides, version 2', () => {
  test('with no rules a slide is the built-in style', () => {
    const slide = first(v2())
    expect(slide.headline).toMatchObject({ ...BUILT_IN_STYLE.headline, text: 'You' })
    expect(slide.subheadline).toMatchObject({ ...BUILT_IN_STYLE.subheadline, text: '' })
    expect(slide.badge).toEqual(BUILT_IN_STYLE.badge)
    expect(slide.background).toMatchObject(BUILT_IN_STYLE.background)
    expect(slide.device.scale).toBe(BUILT_IN_STYLE.device.scale)
    expect(slide.showMascot).toBe(true)
    expect(slide.mascotPosition).toBe('top-center')
  })

  test('merge order: built-in, style, target, slide style, slide target', () => {
    const slideOf = (rules: Pick<ProjectV2, 'style' | 'targets'> & { slide?: object }) =>
      first(
        v2({
          style: rules.style,
          targets: rules.targets,
          slides: [{ shot: '01-you.png', headline: 'You', ...rules.slide }],
        }),
        'ipad',
      ).device.scale
    expect(slideOf({})).toBe(0.76)
    expect(slideOf({ style: { device: { scale: 0.8 } } })).toBe(0.8)
    expect(
      slideOf({ style: { device: { scale: 0.8 } }, targets: { ipad: { device: { scale: 0.7 } } } }),
    ).toBe(0.7)
    expect(
      slideOf({
        style: { device: { scale: 0.8 } },
        targets: { ipad: { device: { scale: 0.7 } } },
        slide: { style: { device: { scale: 0.6 } } },
      }),
    ).toBe(0.6)
    expect(
      slideOf({
        targets: { ipad: { device: { scale: 0.7 } } },
        slide: { style: { device: { scale: 0.6 } }, targets: { ipad: { device: { scale: 0.5 } } } },
      }),
    ).toBe(0.5)
  })

  test('objects merge by field, not whole', () => {
    const slide = first(
      v2({
        style: { headline: { color: '#123456', fontSize: 150 } },
        targets: { ios: { headline: { fontSize: 120 } } },
      }),
    )
    expect(slide.headline).toMatchObject({
      color: '#123456',
      fontSize: 120,
      fontFamily: BUILT_IN_STYLE.headline.fontFamily,
    })
  })

  test('a target override leaves the other targets alone', () => {
    const project = v2({ targets: { ipad: { device: { scale: 0.7 } } } })
    expect(first(project, 'ipad').device.scale).toBe(0.7)
    expect(first(project, 'ios').device.scale).toBe(0.76)
    expect(first(project, 'android').device.scale).toBe(0.76)
  })

  test('a slide override leaves the other slides alone', () => {
    const project = v2({
      slides: [
        { shot: '01-you.png', headline: 'You', style: { device: { yOffset: 9 } } },
        { shot: '02-map.png', headline: 'Map' },
      ],
    })
    expect(first(project, 'ios', 0).device.yOffset).toBe(9)
    expect(first(project, 'ios', 1).device.yOffset).toBe(BUILT_IN_STYLE.device.yOffset)
  })

  test('derives id, name, order and sourceFile', () => {
    const [a, b, c] = resolveSlides(
      v2({
        slides: [
          { shot: '01-you.png', headline: 'You' },
          { shot: 'map.png', headline: 'Map', name: 'The map' },
          { shot: '03-x.png', id: 'custom', headline: 'X' },
        ],
      }),
      'ios',
    ) as [ReturnType<typeof first>, ReturnType<typeof first>, ReturnType<typeof first>]
    expect([a.id, a.name, a.order, a.sourceFile]).toEqual(['you', 'you', 0, '01-you.png'])
    expect([b.id, b.name, b.order]).toEqual(['map', 'The map', 1])
    expect([c.id, c.name]).toEqual(['custom', 'custom'])
    expect(derivedId('02-journal-calendar.png')).toBe('journal-calendar')
    expect(derivedId('12_home.screen.png')).toBe('home.screen')
    expect(derivedId('01.png')).toBe('01')
  })

  test('text comes from the slide; the badge text falls back to the rules', () => {
    const project = v2({ style: { badge: { enabled: true, text: 'COZY' } } })
    expect(first(project, 'ios', 0).badge).toMatchObject({ enabled: true, text: 'COZY' })
    expect(first(project, 'ios', 1).badge.text).toBe('NEW')
    expect(first(project, 'ios', 1).subheadline.text).toBe('On one map')
  })

  test('the frame and corner follow the target', () => {
    for (const target of ['ios', 'ipad', 'android'] as const) {
      const slide = first(v2(), target)
      expect(slide.platform).toBe(target)
      expect(slide.device).toMatchObject(TARGET_FRAME[target])
    }
    // A platform frame named in the rules is still the target's own.
    expect(first(v2({ style: { device: { frameType: 'iphone-pro' } } }), 'android').device.frameType).toBe(
      'android-pixel',
    )
  })

  test('a clay, glass or frameless frame stays on every target', () => {
    const project = v2({ style: { device: { frameType: 'clay-minimal' } } })
    for (const target of ['ios', 'ipad', 'android'] as const) {
      expect(first(project, target).device).toMatchObject({ frameType: 'clay-minimal', cornerRadius: 56 })
    }
    expect(
      first(v2({ style: { device: { frameType: 'frameless', cornerRadius: 30 } } })).device.cornerRadius,
    ).toBe(30)
  })

  test('the panorama index and count are the position and the slide count', () => {
    const slides = resolveSlides(v2(), 'android')
    expect(slides.map((s) => [s.background.panoramaSlideIndex, s.background.panoramaTotalSlides])).toEqual([
      [0, 2],
      [1, 2],
    ])
  })

  test('brand replaces showMascot and mascotPosition', () => {
    const slide = first(v2({ style: { brand: { show: false, position: 'bottom-left' } } }))
    expect([slide.showMascot, slide.mascotPosition]).toEqual([false, 'bottom-left'])
  })
})

describe('parseProject, version 2', () => {
  const issue = (value: unknown): string => {
    try {
      parseProject(value)
    } catch (e) {
      return (e as Error).message
    }
    throw new Error('did not throw')
  }

  test('two slides with the same derived id are refused', () => {
    expect(
      issue(
        v2({
          slides: [
            { shot: '01-you.png', headline: 'a' },
            { shot: '02-you.png', headline: 'b' },
          ],
        }),
      ),
    ).toContain('slides.1.id: Duplicate slide id "you"')
  })

  test('an own id that collides with a derived one is refused', () => {
    expect(
      issue(
        v2({
          slides: [
            { shot: '01-you.png', headline: 'a' },
            { shot: 'x.png', id: 'you', headline: 'b' },
          ],
        }),
      ),
    ).toContain('slides.1.id')
  })

  test('an unknown key is refused with its path', () => {
    expect(issue({ ...v2(), style: { headline: { colour: 'red' } } })).toContain('style.headline')
    expect(issue({ ...v2(), slides: [{ shot: 'a.png', headline: 'a', imageSrc: 'x' }] })).toContain(
      'slides.0',
    )
    expect(issue({ ...v2(), targets: { tablet: {} } })).toContain('targets')
    expect(issue({ ...v2(), platform: 'ios' })).toContain('(root)')
  })

  test('angled-3d and removed fields are refused', () => {
    expect(issue({ ...v2(), style: { device: { position: 'angled-3d' } } })).toContain(
      'style.device.position',
    )
    expect(issue({ ...v2(), style: { background: { blur: 1 } } })).toContain('style.background')
  })

  test('locales name slide ids, derived ones included', () => {
    const ok = v2({ locales: { fr: { you: { headline: 'Toi' } } } })
    expect(parseProject(ok)).toEqual(ok)
    expect(issue(v2({ locales: { fr: { '01-you': { headline: 'Toi' } } } }))).toContain('locales.fr.01-you')
  })
})
