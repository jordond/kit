import { describe, expect, test } from 'bun:test'
import {
  distance,
  dragPlacement,
  hitsDevice,
  NUDGE,
  NUDGE_BIG,
  nudgePlacement,
  PLACEMENT_LIMITS,
  pinchScale,
  toCanvas,
  wheelScale,
} from '../../editor/src/gesture'
import { STYLE_GROUPS } from '../../editor/src/panel/fields'
import type { SlideLayout } from '../../src/lib/storeshots/page/renderer'

const layout: SlideLayout = {
  width: 1000,
  height: 2000,
  headlineLines: 1,
  subheadlineLines: 0,
  textBottom: 300,
  device: { x: 100, y: 600, width: 800, height: 1700 },
  textPushesDevice: true,
}
// A canvas shown at a fifth of its drawn size.
const box = { width: 200, height: 400 }
const start = { xOffset: 0, yOffset: 2, scale: 0.76 }

describe('placing the device by hand', () => {
  test('the limits are the panel fields ranges', () => {
    const fields = STYLE_GROUPS.flatMap((g) => g.blocks.flatMap((b) => b.fields)).filter(
      (f) => f.field.section === 'device',
    )
    const num = (key: string) => {
      const c = fields.find((f) => f.field.key === key)!.control
      if (c.kind !== 'number') throw new Error('not a number control')
      return c
    }
    for (const key of ['xOffset', 'yOffset']) {
      expect([num(key).min, num(key).max]).toEqual([PLACEMENT_LIMITS.offset.min, PLACEMENT_LIMITS.offset.max])
    }
    expect([num('scale').min, num('scale').max]).toEqual([
      PLACEMENT_LIMITS.scale.min,
      PLACEMENT_LIMITS.scale.max,
    ])
  })

  test('a point over the canvas maps to the pixels of the draw', () => {
    expect(toCanvas({ x: 100, y: 200 }, box, layout)).toEqual({ x: 500, y: 1000 })
  })

  test('a drag across the whole canvas is 100 percent, in the units of the fields', () => {
    expect(dragPlacement(start, { x: 20, y: 0 }, box)).toEqual({ xOffset: 10, yOffset: 2, scale: 0.76 })
    expect(dragPlacement(start, { x: 0, y: 40 }, box)).toEqual({ xOffset: 0, yOffset: 12, scale: 0.76 })
    expect(dragPlacement(start, { x: -200, y: -400 }, box)).toMatchObject({ xOffset: -50, yOffset: -50 })
  })

  test('a drag stops at the field limits and rounds to a tenth', () => {
    expect(dragPlacement(start, { x: 10_000, y: 10_000 }, box)).toMatchObject({ xOffset: 50, yOffset: 50 })
    expect(dragPlacement(start, { x: 0.37, y: 0 }, box).xOffset).toBe(0.2)
  })

  test('a canvas with no size is not dragged', () => {
    expect(dragPlacement(start, { x: 5, y: 5 }, { width: 0, height: 0 })).toBe(start)
  })

  test('the hit test follows the device rect the renderer drew', () => {
    // The device spans x 100..900 and y 600..2300 of a 1000x2000 draw: x 20..180 and y 120..460 on screen.
    expect(hitsDevice({ x: 100, y: 300 }, box, layout)).toBe(true)
    expect(hitsDevice({ x: 10, y: 300 }, box, layout)).toBe(false)
    expect(hitsDevice({ x: 100, y: 50 }, box, layout)).toBe(false)
    expect(hitsDevice({ x: 100, y: 300 }, { width: 0, height: 0 }, layout)).toBe(false)
  })

  test('a rotated device is hit in its own frame', () => {
    // A tall device turned 90 degrees covers a wide, short area around its centre.
    const tall: SlideLayout = { ...layout, device: { x: 450, y: 600, width: 100, height: 800 } }
    // Centre (500, 1000). Unrotated, 300px right of it is outside; turned a quarter it is inside.
    const p = { x: (500 + 300) / 5, y: 1000 / 5 }
    expect(hitsDevice(p, box, tall, 0)).toBe(false)
    expect(hitsDevice(p, box, tall, 90)).toBe(true)
  })

  test('wheel steps scale up and down, clamped, with a trackpad pinch moving faster', () => {
    expect(wheelScale(0.76, -100, false)).toBeGreaterThan(0.76)
    expect(wheelScale(0.76, 100, false)).toBeLessThan(0.76)
    expect(wheelScale(0.76, -100, true)).toBeGreaterThan(wheelScale(0.76, -100, false))
    expect(wheelScale(1.49, -10_000, false)).toBe(PLACEMENT_LIMITS.scale.max)
    expect(wheelScale(0.31, 10_000, false)).toBe(PLACEMENT_LIMITS.scale.min)
    expect(wheelScale(0.76, 0, false)).toBe(0.76)
  })

  test('a pinch scales by how far the fingers moved apart', () => {
    expect(pinchScale(0.5, 100, 200)).toBe(1)
    expect(pinchScale(1, 100, 50)).toBe(0.5)
    expect(pinchScale(0.5, 0, 200)).toBe(0.5)
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  test('arrow keys nudge by half a percent, two with Shift, and nothing else does', () => {
    expect(nudgePlacement(start, 'ArrowRight', false)).toEqual({ ...start, xOffset: NUDGE })
    expect(nudgePlacement(start, 'ArrowLeft', true)).toEqual({ ...start, xOffset: -NUDGE_BIG })
    expect(nudgePlacement(start, 'ArrowUp', false)).toEqual({ ...start, yOffset: 2 - NUDGE })
    expect(nudgePlacement(start, 'ArrowDown', true)).toEqual({ ...start, yOffset: 2 + NUDGE_BIG })
    expect(nudgePlacement(start, 'a', false)).toBeNull()
    expect(nudgePlacement({ ...start, xOffset: 50 }, 'ArrowRight', true)?.xOffset).toBe(50)
  })
})
