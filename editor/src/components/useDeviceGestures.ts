import { type RefObject, useEffect, useRef } from 'react'
import type { DeviceTarget } from '../../../src/lib/devices'
import type { SlideLayout } from '../../../src/lib/storeshots/page/renderer'
import type { Slide } from '../../../src/lib/storeshots/types'
import {
  type Box,
  distance,
  dragPlacement,
  hitsDevice,
  nudgePlacement,
  type Placement,
  pinchScale,
  wheelScale,
} from '../gesture'
import { editorStore } from '../store'

/** Wheel steps or key presses closer together than this are one gesture, so one undo step. */
const BURST_MS = 450

const DEVICE = (key: string) => ({ section: 'device', key }) as const
const X = DEVICE('xOffset')
const Y = DEVICE('yOffset')
const SCALE = DEVICE('scale')

const placementOf = (slide: Slide): Placement => ({
  xOffset: slide.device.xOffset,
  yOffset: slide.device.yOffset,
  scale: slide.device.scale,
})

let gestures = 0
const newGesture = (kind: string): string => `${kind}-${++gestures}`

interface Input {
  target: DeviceTarget
  slide: Slide | null
  /** The canvas's on-screen size. */
  box: Box
  /** The layout of the last draw, set by the canvas. */
  layout: RefObject<SlideLayout | null>
}

/**
 * Drag, wheel, pinch and arrow keys on one canvas, writing `device.xOffset`, `yOffset` and `scale`
 * at the editor's current scope for `target`. A drag is one gesture: every write carries its id, and
 * the store joins them into one undo entry. Returns the props for the element laid over the canvas.
 */
export function useDeviceGestures({ target, slide, box, layout }: Input) {
  const overlay = useRef<HTMLDivElement>(null)
  // The handlers read the latest props through a ref: they are attached once.
  const latest = useRef({ target, slide, box })
  latest.current = { target, slide, box }

  const write = (gesture: string, p: Placement, fields: ('xy' | 'scale')[]): void => {
    const state = editorStore.getState()
    state.writeStyles(
      state.scope,
      [
        ...(fields.includes('xy')
          ? [
              { field: X, value: p.xOffset },
              { field: Y, value: p.yOffset },
            ]
          : []),
        ...(fields.includes('scale') ? [{ field: SCALE, value: p.scale }] : []),
      ],
      gesture,
    )
  }

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef<{
    id: string
    start: Placement
    from: { x: number; y: number }
    pinch?: { distance: number; scale: number; id: string }
  } | null>(null)

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = overlay.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }

  const onDevice = (point: { x: number; y: number }): boolean => {
    const { slide: s, box: b } = latest.current
    const l = layout.current
    return !!s && !!l && hitsDevice(point, b, l, s.device.rotation)
  }

  // A wheel listener has to be non-passive to keep the page from scrolling under a zoom.
  const burst = useRef({ id: '', at: 0 })
  useEffect(() => {
    const el = overlay.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const { slide: s, target: t } = latest.current
      if (!s || !onDevice(local(e))) return
      e.preventDefault()
      const now = performance.now()
      if (now - burst.current.at > BURST_MS) burst.current.id = newGesture('wheel')
      burst.current.at = now
      editorStore.getState().setTarget(t)
      const start = placementOf(s)
      const scale = wheelScale(start.scale, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, e.ctrlKey)
      write(burst.current.id, { ...start, scale }, ['scale'])
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // `onDevice` and `write` read refs only.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])

  return {
    ref: overlay,
    tabIndex: 0,
    onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      const s = latest.current.slide
      if (!s || e.button !== 0) return
      const point = local(e)
      if (!pointers.current.size && !onDevice(point)) return
      e.currentTarget.setPointerCapture(e.pointerId)
      pointers.current.set(e.pointerId, point)
      editorStore.getState().setTarget(latest.current.target)
      const start = placementOf(s)
      if (pointers.current.size === 1) {
        drag.current = { id: newGesture('drag'), start, from: point }
      } else if (drag.current && pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()]
        drag.current.pinch = { distance: distance(a!, b!), scale: start.scale, id: newGesture('pinch') }
      }
    },
    onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
      const point = local(e)
      const g = drag.current
      if (!g || !pointers.current.has(e.pointerId)) {
        // Hovering: the cursor says whether a drag would grab the device.
        if (overlay.current) overlay.current.style.cursor = onDevice(point) ? 'grab' : 'default'
        return
      }
      pointers.current.set(e.pointerId, point)
      if (g.pinch && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()]
        const scale = pinchScale(g.pinch.scale, g.pinch.distance, distance(a!, b!))
        write(g.pinch.id, { ...g.start, scale }, ['scale'])
        return
      }
      if (pointers.current.size > 1) return
      const next = dragPlacement(
        g.start,
        { x: point.x - g.from.x, y: point.y - g.from.y },
        latest.current.box,
      )
      write(g.id, next, ['xy'])
    },
    onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
      pointers.current.delete(e.pointerId)
      if (pointers.current.size === 0) drag.current = null
      else if (pointers.current.size === 1 && drag.current) {
        // One finger left after a pinch: carry on dragging from where it is, from the current values.
        const s = latest.current.slide
        const [rest] = [...pointers.current.values()]
        if (s && rest) drag.current = { id: newGesture('drag'), start: placementOf(s), from: rest }
      }
    },
    onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
      const s = latest.current.slide
      if (!s) return
      const next = nudgePlacement(placementOf(s), e.key, e.shiftKey)
      if (!next) return
      e.preventDefault()
      const now = performance.now()
      if (now - burst.current.at > BURST_MS) burst.current.id = newGesture('keys')
      burst.current.at = now
      editorStore.getState().setTarget(latest.current.target)
      write(burst.current.id, next, ['xy'])
    },
  }
}
