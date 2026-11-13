import { deviceLinear, toDeviceFrame } from '../../src/lib/storeshots/page/device-transform'
import type { SlideLayout } from '../../src/lib/storeshots/page/renderer'

/**
 * The arithmetic of placing the device by hand: pointer positions to canvas pixels, a hit test on
 * the device the renderer drew, and a drag, wheel, pinch or key press to the `device` fields.
 * Pure: the component feeds it numbers and writes what comes back.
 *
 * Offsets are percent of the canvas (x of the width, y of the height), the same units as the panel
 * fields, so a drag across a whole canvas is 100.
 */

/** The ranges of the panel fields (`panel/fields.ts` has the same numbers; a test keeps them equal). */
export const PLACEMENT_LIMITS = {
  offset: { min: -50, max: 50 },
  scale: { min: 0.3, max: 1.5 },
} as const

/** A key press nudges by this much percent; with Shift, by `NUDGE_BIG`. */
export const NUDGE = 0.5
export const NUDGE_BIG = 2

export interface Point {
  x: number
  y: number
}

/** The on-screen size of the canvas, in CSS pixels. */
export interface Box {
  width: number
  height: number
}

export interface Placement {
  xOffset: number
  yOffset: number
  scale: number
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const round = (value: number, places: number): number => {
  const f = 10 ** places
  return Math.round(value * f) / f
}

const clampOffset = (value: number): number =>
  round(clamp(value, PLACEMENT_LIMITS.offset.min, PLACEMENT_LIMITS.offset.max), 1)
const clampScale = (value: number): number =>
  round(clamp(value, PLACEMENT_LIMITS.scale.min, PLACEMENT_LIMITS.scale.max), 2)

/** A point in CSS pixels over the canvas, as pixels of the canvas the renderer drew. */
export function toCanvas(point: Point, box: Box, layout: Pick<SlideLayout, 'width' | 'height'>): Point {
  return { x: (point.x * layout.width) / box.width, y: (point.y * layout.height) / box.height }
}

/**
 * Whether a point (CSS pixels over the canvas) is on the device the renderer drew: the point is
 * taken back through the rotation and tilt the renderer drew with (`deviceLinear`) into the
 * device's own frame, where the device is its plain rect.
 */
export function hitsDevice(point: Point, box: Box, layout: SlideLayout, rotation = 0, tilt = 0): boolean {
  if (box.width <= 0 || box.height <= 0) return false
  const p = toCanvas(point, box, layout)
  const { x, y, width, height } = layout.device
  const local = toDeviceFrame(p.x - (x + width / 2), p.y - (y + height / 2), deviceLinear(rotation, tilt))
  if (!local) return false
  return Math.abs(local.x) <= width / 2 && Math.abs(local.y) <= height / 2
}

/** The offsets after dragging `delta` CSS pixels from where the gesture began. */
export function dragPlacement(start: Placement, delta: Point, box: Box): Placement {
  if (box.width <= 0 || box.height <= 0) return start
  return {
    ...start,
    xOffset: clampOffset(start.xOffset + (delta.x / box.width) * 100),
    yOffset: clampOffset(start.yOffset + (delta.y / box.height) * 100),
  }
}

/** The scale after a wheel step; a trackpad pinch arrives as a wheel with `ctrlKey` and moves in smaller steps. */
export function wheelScale(scale: number, deltaY: number, pinch: boolean): number {
  return clampScale(scale * Math.exp(-deltaY * (pinch ? 0.01 : 0.002)))
}

/** The scale of a two-finger pinch: the start scale times how much the fingers moved apart. */
export function pinchScale(startScale: number, startDistance: number, distance: number): number {
  if (startDistance <= 0) return startScale
  return clampScale(startScale * (distance / startDistance))
}

/** The offsets after an arrow key; `null` for any other key. */
export function nudgePlacement(start: Placement, key: string, shift: boolean): Placement | null {
  const step = shift ? NUDGE_BIG : NUDGE
  const delta: Record<string, Point> = {
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
  }
  const d = delta[key]
  if (!d) return null
  return { ...start, xOffset: clampOffset(start.xOffset + d.x), yOffset: clampOffset(start.yOffset + d.y) }
}

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
