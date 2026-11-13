import { renderSlideToCanvas, type SlideLayout } from '../../../src/lib/storeshots/page/renderer'
import type { PageBrand, Slide } from '../../../src/lib/storeshots/types'
import { assetUrl } from '../api'
import { cachedImage } from './assets'

/** What one canvas shows: a slide on a raw shot, at a pixel size. */
export interface DrawRequest {
  slide: Slide
  /** URL of the raw shot. */
  shot: string
  brand: PageBrand | null
  /** The canvas's pixel size: the preview resolution, not the export size. */
  width: number
  height: number
}

export interface CanvasRenderer {
  /** Asks for a draw. Many calls within a frame cost one render, of the last request. */
  request(req: DrawRequest): void
  /** Stops the renderer: no more draws, and the one in flight is dropped. */
  dispose(): void
}

/**
 * The render loop of one visible canvas.
 *
 * - Coalescing: `request` only records the request and schedules one animation frame.
 * - One in flight: a frame that finds a render still running waits for it, then draws the latest.
 * - Cancelling: each render carries a generation; after every await it checks it is still the
 *   newest, and a stale one never touches the canvas.
 * - No flicker: the slide is drawn on an offscreen canvas, then blitted onto the visible one in
 *   the same task as the resize (resizing a canvas clears it).
 */
export function createCanvasRenderer(
  canvas: HTMLCanvasElement,
  onError: (error: Error | null) => void,
  /** Called once a draw reached the canvas, with where it put the text and the device. */
  onDrawn?: (layout: SlideLayout) => void,
): CanvasRenderer {
  const offscreen = document.createElement('canvas')
  let latest: DrawRequest | undefined
  let generation = 0
  let frame = 0
  let running = false
  let disposed = false

  async function render(req: DrawRequest, mine: number): Promise<void> {
    try {
      const [shot, mark] = await Promise.all([
        cachedImage(req.shot, 'The raw shot'),
        req.slide.showMascot && req.brand
          ? cachedImage(assetUrl(req.brand.mark), 'The brand mark')
          : Promise.resolve(null),
      ])
      if (mine !== generation || disposed) return
      const layout = await renderSlideToCanvas(req.slide, offscreen, req.width, req.height, {
        shot,
        brand: req.brand,
        mark,
      })
      if (mine !== generation || disposed) return
      if (canvas.width !== req.width) canvas.width = req.width
      if (canvas.height !== req.height) canvas.height = req.height
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('Could not get 2D canvas rendering context')
      ctx.drawImage(offscreen, 0, 0)
      onError(null)
      onDrawn?.(layout)
    } catch (err) {
      if (mine === generation && !disposed) onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  async function run(): Promise<void> {
    frame = 0
    if (running || disposed || !latest) return
    running = true
    try {
      // A request that arrives mid-render has bumped the generation: loop until nothing newer is left.
      let drawn: DrawRequest | undefined
      while (latest && latest !== drawn && !disposed) {
        drawn = latest
        await render(drawn, generation)
      }
    } finally {
      running = false
    }
  }

  return {
    request(req) {
      latest = req
      generation += 1
      if (!frame && !running) frame = requestAnimationFrame(() => void run())
    },
    dispose() {
      disposed = true
      generation += 1
      if (frame) cancelAnimationFrame(frame)
    },
  }
}
