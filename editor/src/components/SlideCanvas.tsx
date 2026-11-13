import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DeviceTarget } from '../../../src/lib/devices'
import type { SlideLayout } from '../../../src/lib/storeshots/page/renderer'
import type { PageBrand, Slide } from '../../../src/lib/storeshots/types'
import { type CanvasRenderer, createCanvasRenderer } from '../render/pipeline'
import { useDeviceGestures } from './useDeviceGestures'

export interface SlideDraw {
  slide: Slide
  /** URL of the raw shot. */
  shot: string
  brand: PageBrand | null
}

interface Props {
  /** The export size: sets the aspect and caps the preview resolution. */
  size: { width: number; height: number }
  /** What to draw; `null` shows `empty` instead. */
  draw: SlideDraw | null
  empty?: ReactNode
  /** Fixed CSS width, for thumbnails. Without it the canvas fits the parent's box. */
  cssWidth?: number
  /** Draw at the export size, one canvas pixel per CSS pixel, instead of fitting the box: the parent scrolls. */
  actualSize?: boolean
  /** The target this canvas shows; set, the device can be dragged, zoomed and nudged on it. */
  manipulate?: { target: DeviceTarget; label: string }
}

/** The size of an element's box, kept current. */
function useBox(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect
      setBox((old) => (old.width === width && old.height === height ? old : { width, height }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return box
}

/**
 * One slide on one canvas, fitted into its parent. The canvas is sized to the on-screen box times
 * the device pixel ratio, capped at the export width: the renderer scales from the width, so a
 * preview is the export at lower resolution.
 */
export function SlideCanvas({ size, draw, empty, cssWidth, actualSize, manipulate }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<CanvasRenderer | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const layout = useRef<SlideLayout | null>(null)
  const box = useBox(host)

  const aspect = size.width / size.height
  const avail = cssWidth ? { width: cssWidth, height: cssWidth / aspect } : box
  const fit = actualSize ? size.width : Math.min(avail.width, avail.height * aspect)
  const css = { width: Math.floor(fit), height: Math.floor(fit / aspect) }
  const px = actualSize
    ? size.width
    : Math.min(size.width, Math.ceil(css.width * (window.devicePixelRatio || 1)))
  const pixels = { width: px, height: Math.round(px / aspect) }
  const gestures = useDeviceGestures({
    target: manipulate?.target ?? 'ios',
    slide: draw?.slide ?? null,
    box: css,
    layout,
  })

  useEffect(() => {
    if (!canvas.current) return
    const r = createCanvasRenderer(canvas.current, setError, (l) => {
      layout.current = l
    })
    renderer.current = r
    return () => {
      r.dispose()
      renderer.current = null
    }
  }, [])

  // The content of a request, not its identity: an edit elsewhere rebuilds every resolved slide,
  // and only a slide whose own content changed is redrawn.
  const key = useMemo(() => (draw ? JSON.stringify(draw) : ''), [draw])
  useEffect(() => {
    if (!draw || pixels.width < 2) return
    renderer.current?.request({ ...draw, ...pixels })
    // `key` stands for `draw`.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [key, pixels.width, pixels.height])

  return (
    <div
      ref={host}
      className={
        actualSize
          ? 'flex w-max items-start'
          : `flex h-full w-full justify-center ${cssWidth ? 'items-center' : 'items-start'}`
      }
      style={cssWidth ? { height: css.height } : undefined}
    >
      <div
        className="relative overflow-hidden rounded-[3px] bg-zinc-900 shadow-lg ring-1 ring-white/10"
        style={css}
      >
        <canvas ref={canvas} className={draw ? 'block' : 'hidden'} style={css} />
        {manipulate && draw && (
          <div
            {...gestures}
            onPointerCancel={(e) => gestures.onPointerUp(e)}
            role="group"
            aria-label={`${manipulate.label} canvas. Drag the device to place it, scroll over it to scale it, arrow keys nudge it`}
            data-gestures={manipulate.target}
            className="absolute inset-0 touch-none outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset"
          />
        )}
        {!draw && (
          <div className="flex h-full w-full items-center justify-center p-3 text-center">{empty}</div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 p-3 text-center text-[11px] text-red-300">
            {error.message}
          </div>
        )}
      </div>
    </div>
  )
}
