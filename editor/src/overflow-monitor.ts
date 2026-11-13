import { createStore, type StoreApi } from 'zustand/vanilla'
import type { DeviceTarget } from '../../src/lib/devices'
import type { SlideLayout } from '../../src/lib/storeshots/page/renderer'
import type { PageBrand, Slide } from '../../src/lib/storeshots/types'
import { type Overflow, overflowReasons } from './overflow'
import { findShot, slidesFor } from './slides'
import { type EditorState, localesOf } from './store-core'

/**
 * Finds the slides whose text overflows, for every locale and target, off the interaction path.
 *
 * After an edit (debounced) the monitor walks every slide of every locale on every target, measures
 * it with `measure` (the editor wires a small offscreen draw), and keeps the result in its own
 * store. A draw is measured once per content: the cache is keyed by the slide, its shot and the
 * size, so an edit re-measures only the slides it changed. Between draws the monitor yields to the
 * browser (`idle`), and a newer edit abandons a walk in progress.
 */

export interface MeasureJob {
  slide: Slide
  /** URL of the raw shot. */
  shot: string
  brand: PageBrand | null
  /** The export size of the target: the draw is a scaled copy of it. */
  size: { width: number; height: number }
}

export interface MonitorDeps {
  measure: (job: MeasureJob) => Promise<SlideLayout>
  shotUrl: (target: DeviceTarget, shot: { path: string }, rev: number) => string
  /** Resolves when the browser has a quiet moment. */
  idle: () => Promise<void>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Quiet time after a change before a walk starts. */
  debounceMs?: number
}

export interface OverflowState {
  /** Every overflow found by the last finished walk. */
  items: Overflow[]
  /** A walk is in progress (the items are the previous walk's). */
  measuring: boolean
}

export type OverflowStore = StoreApi<OverflowState>

export const createOverflowStore = (): OverflowStore =>
  createStore<OverflowState>(() => ({ items: [], measuring: false }))

const CACHE_LIMIT = 3000

/** Starts watching `editor`; returns what to call to stop. */
export function startOverflowMonitor(
  editor: StoreApi<EditorState>,
  out: OverflowStore,
  deps: MonitorDeps,
): () => void {
  const debounceMs = deps.debounceMs ?? 400
  const cache = new Map<string, SlideLayout | null>()
  let token = 0
  let timer: unknown = null

  async function walk(mine: number): Promise<void> {
    const { project, session, shots, shotsRev } = editor.getState()
    if (!project || !session || !shots) {
      out.setState({ items: [], measuring: false })
      return
    }
    out.setState({ measuring: true })
    const items: Overflow[] = []
    for (const locale of localesOf(session, project)) {
      for (const target of session.targets) {
        const set = session.sets[target]
        if (!set) continue
        for (const slide of slidesFor(project, target, locale)) {
          const shot = findShot(shots, target, slide, locale)
          // No raw shot, nothing drawn, nothing to overflow: the stage already says it is missing.
          if (!shot) continue
          const url = deps.shotUrl(target, shot, shotsRev)
          const key = JSON.stringify([slide, url, session.brand, set.width, set.height])
          let layout = cache.get(key)
          if (layout === undefined) {
            await deps.idle()
            if (mine !== token) return
            try {
              layout = await deps.measure({
                slide,
                shot: url,
                brand: session.brand,
                size: { width: set.width, height: set.height },
              })
            } catch {
              // A shot or font that does not load is reported by the canvas itself.
              layout = null
            }
            if (mine !== token) return
            if (cache.size > CACHE_LIMIT) cache.clear()
            cache.set(key, layout)
          }
          const reasons = layout ? overflowReasons(layout) : []
          if (reasons.length > 0) items.push({ slideId: slide.id, target, locale, reasons })
        }
      }
    }
    if (mine === token) out.setState({ items, measuring: false })
  }

  const schedule = (): void => {
    if (timer !== null) deps.clearTimer(timer)
    token += 1
    timer = deps.setTimer(() => {
      timer = null
      void walk(token)
    }, debounceMs)
  }

  let last = editor.getState()
  const unsubscribe = editor.subscribe((state) => {
    const same =
      state.project === last.project &&
      state.session === last.session &&
      state.shots === last.shots &&
      state.shotsRev === last.shotsRev
    last = state
    if (!same) schedule()
  })
  if (last.project) schedule()
  return () => {
    unsubscribe()
    token += 1
    if (timer !== null) deps.clearTimer(timer)
  }
}

/** The overflows of one slide. */
export const overflowsOf = (items: readonly Overflow[], slideId: string): Overflow[] =>
  items.filter((o) => o.slideId === slideId)
