import { renderSlideToCanvas, type SlideLayout } from '../../../src/lib/storeshots/page/renderer'
import { assetUrl } from '../api'
import type { MeasureJob } from '../overflow-monitor'
import { cachedImage } from './assets'

/** Wide enough that text wraps as it does in the export (the renderer scales from the width), small enough to be cheap. */
const MEASURE_WIDTH = 440

let canvas: HTMLCanvasElement | undefined

/** Draws the slide on a small offscreen canvas and returns the layout; the pixels are thrown away. */
export async function measureLayout(job: MeasureJob): Promise<SlideLayout> {
  canvas ??= document.createElement('canvas')
  const [shot, mark] = await Promise.all([
    cachedImage(job.shot, 'The raw shot'),
    job.slide.showMascot && job.brand
      ? cachedImage(assetUrl(job.brand.mark), 'The brand mark')
      : Promise.resolve(null),
  ])
  const height = Math.round((MEASURE_WIDTH * job.size.height) / job.size.width)
  return renderSlideToCanvas(job.slide, canvas, MEASURE_WIDTH, height, { shot, brand: job.brand, mark })
}

/** Resolves at the browser's next quiet moment (or soon after, where there is no idle callback). */
export const idle = (): Promise<void> =>
  new Promise((ok) => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => ok(), { timeout: 500 })
    else setTimeout(ok, 16)
  })
