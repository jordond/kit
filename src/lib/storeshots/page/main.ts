/// <reference lib="dom" />
import { cssFamily } from '../fonts'
import type { PageDone, PageFont, PageJob, PagePlan } from '../types'
import { loadImage, renderSlideToCanvas } from './renderer'

/**
 * The page headless Chrome runs for `kit shots export`. Every URL is relative to the page URL
 * (`/<token>/`): it reads `plan.json`, loads the fonts, renders each job from `shot/<jobId>`, posts
 * the PNG to `out/<jobId>`, and posts `done` exactly once, last.
 */

const url = (path: string): string => new URL(path, document.baseURI).href

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

let finished = false

/** Posts `done` once; a later call (a late error after the run ended) is dropped. */
async function done(result: PageDone): Promise<void> {
  if (finished) return
  finished = true
  try {
    await fetch(url('done'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    })
  } catch {
    // The render host is gone: nobody is left to tell.
  }
}

/** A failure while rendering one job; `done` then says which, so the render host can name its raw shot. */
class JobError extends Error {
  constructor(
    readonly job: string,
    cause: unknown,
  ) {
    super(message(cause))
  }
}

const fail = (err: unknown): Promise<void> =>
  done({ ok: false, error: message(err), ...(err instanceof JobError ? { job: err.job } : {}) })

/**
 * Loads one face and proves it is usable. A canvas draw of an unloaded face paints the fallback
 * without any error, so a face that fails here ends the run.
 */
async function loadFont(font: PageFont): Promise<void> {
  const name = font.weight ? `${font.family} (${font.weight})` : font.family
  const face = new FontFace(
    font.family,
    `url("${url(font.url)}")`,
    font.weight ? { weight: font.weight } : {},
  )
  try {
    await face.load()
  } catch (err) {
    throw new Error(`Failed to load font ${name} from ${font.url}: ${message(err)}`)
  }
  document.fonts.add(face)
  // A range (`400 800`) is checked at its first weight.
  const weight = font.weight?.trim().split(/\s+/)[0] || '400'
  if (!document.fonts.check(`${weight} 16px ${cssFamily(font.family)}`)) {
    throw new Error(`Font ${name} from ${font.url} loaded but is not usable`)
  }
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the canvas as PNG'))),
      'image/png',
    )
  })
}

async function renderJob(
  job: PageJob,
  canvas: HTMLCanvasElement,
  plan: PagePlan,
  mark: HTMLImageElement | null,
): Promise<void> {
  try {
    await renderSlideToCanvas(job.slide, canvas, job.width, job.height, {
      shot: url(`shot/${job.id}`),
      brand: plan.brand,
      mark,
    })
    if (canvas.width !== job.width || canvas.height !== job.height) {
      throw new Error(`canvas is ${canvas.width}x${canvas.height}, expected ${job.width}x${job.height}`)
    }
    const res = await fetch(url(`out/${job.id}`), {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: await toPng(canvas),
    })
    if (!res.ok) throw new Error(`POST out/${job.id} answered ${res.status}`)
  } catch (err) {
    throw new JobError(job.id, err)
  }
}

async function run(): Promise<void> {
  const res = await fetch(url('plan.json'))
  if (!res.ok) throw new Error(`GET plan.json answered ${res.status}`)
  const plan = (await res.json()) as PagePlan

  await Promise.all(plan.fonts.map(loadFont))
  // Loaded once and only when a slide draws it; a mark that does not load ends the run.
  const mark =
    plan.brand && plan.jobs.some((job) => job.slide.showMascot)
      ? await loadImage(url(plan.brand.mark), 'The brand mark')
      : null

  const canvas = document.createElement('canvas')
  for (const job of plan.jobs) {
    if (finished) return
    await renderJob(job, canvas, plan, mark)
  }
  await done({ ok: true })
}

window.addEventListener('error', (event) => void fail(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => void fail(event.reason))

run().catch(fail)
