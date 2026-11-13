import { describe, expect, test } from 'bun:test'
import {
  describeReason,
  OVERFLOW_LIMITS,
  type OverflowReason,
  overflowLabel,
  overflowReasons,
} from '../../editor/src/overflow'
import {
  createOverflowStore,
  type MeasureJob,
  overflowsOf,
  startOverflowMonitor,
} from '../../editor/src/overflow-monitor'
import { createEditorStore, type EditorApi } from '../../editor/src/store-core'
import type { SlideLayout } from '../../src/lib/storeshots/page/renderer'
import { BUILT_IN_STYLE } from '../../src/lib/storeshots/resolve'
import type { StudioSession, StudioShots } from '../../src/lib/storeshots/studio-api'
import type { ProjectV2 } from '../../src/lib/storeshots/types'

const layout = (over: Partial<SlideLayout> = {}): SlideLayout => ({
  width: 1000,
  height: 2000,
  headlineLines: 2,
  subheadlineLines: 1,
  textBottom: 500,
  device: { x: 100, y: 600, width: 800, height: 1700 },
  textPushesDevice: true,
  ...over,
})

describe('the overflow rule', () => {
  test('a layout inside every limit has no reason', () => {
    expect(overflowReasons(layout())).toEqual([])
  })

  test('a headline past the line limit is flagged with its line count', () => {
    const max = OVERFLOW_LIMITS.maxHeadlineLines
    expect(overflowReasons(layout({ headlineLines: max }))).toEqual([])
    expect(overflowReasons(layout({ headlineLines: max + 1 }))).toEqual([
      { kind: 'headline-lines', lines: max + 1 },
    ])
  })

  test('text that ends below the canvas runs off it', () => {
    expect(overflowReasons(layout({ textBottom: 2000 }))).toEqual([])
    expect(overflowReasons(layout({ textBottom: 2001 }))).toEqual([{ kind: 'off-canvas' }])
  })

  test('a device pushed below the floor by the text is flagged, with its top in percent', () => {
    const low = layout({ device: { x: 0, y: 1200, width: 800, height: 1700 } })
    expect(overflowReasons(low)).toEqual([{ kind: 'device-pushed', topPercent: 60 }])
    // The floor is a fraction of the canvas height, inclusive.
    const edge = layout({ device: { x: 0, y: 2000 * OVERFLOW_LIMITS.deviceTopFloor, width: 8, height: 8 } })
    expect(overflowReasons(edge)).toEqual([])
  })

  test('a device that sits low because of its position or offset, not the text, is not flagged', () => {
    const low = layout({ device: { x: 0, y: 1500, width: 800, height: 1700 }, textPushesDevice: false })
    expect(overflowReasons(low)).toEqual([])
  })

  test('off the canvas is reported once, not also as a pushed device', () => {
    const both = layout({ textBottom: 2500, device: { x: 0, y: 2600, width: 8, height: 8 } })
    expect(overflowReasons(both)).toEqual([{ kind: 'off-canvas' }])
  })

  test('every reason is worded, and the label names locale, target and reason', () => {
    const reasons: OverflowReason[] = [
      { kind: 'headline-lines', lines: 5 },
      { kind: 'off-canvas' },
      { kind: 'device-pushed', topPercent: 70 },
    ]
    for (const r of reasons) expect(describeReason(r).length).toBeGreaterThan(10)
    expect(overflowLabel({ locale: 'fr-FR', reasons: [reasons[0]!] }, 'iPhone')).toBe(
      'fr-FR on iPhone: the headline wraps to 5 lines (more than 3)',
    )
  })
})

const session: StudioSession = {
  projectPath: 'p.json',
  rawPath: 'raw',
  targets: ['ios', 'ipad', 'android'],
  sets: {
    ios: { id: 'iphone-6.9', store: 'apple', width: 1320, height: 2868 },
    ipad: { id: 'ipad-13', store: 'apple', width: 2064, height: 2752 },
    android: { id: 'phone', store: 'google', width: 1440, height: 2560 },
  },
  locales: { apple: ['en-US', 'fr-FR'], google: ['en-US'] },
  fonts: [],
  brand: null,
  builtIn: BUILT_IN_STYLE,
  presets: {},
  palette: [],
}

const shot = (file: string) => ({ file, path: file, width: 10, height: 20 })
const shots: StudioShots = { ios: [shot('a.png')], ipad: [], android: [shot('a.png')] }

const project = (): ProjectV2 => ({
  version: 2,
  slides: [{ shot: 'a.png', headline: 'Short' }],
  locales: { 'fr-FR': { a: { headline: 'Un titre extremement long' } } },
})

describe('the overflow monitor', () => {
  async function setup() {
    const api = {
      getSession: async () => session,
      getProject: async () => ({ project: project(), hash: 'h' }),
      getShots: async () => shots,
    } as unknown as EditorApi
    const timers: (() => void)[] = []
    const editor = createEditorStore({
      api,
      loadFonts: async () => {},
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
    })
    await editor.getState().loadAll()
    const jobs: MeasureJob[] = []
    const out = createOverflowStore()
    const stop = startOverflowMonitor(editor, out, {
      // Only the French headline is long: the measure answers from the slide, as the renderer would.
      measure: async (job) => {
        jobs.push(job)
        return layout({ headlineLines: job.slide.headline.text.includes('long') ? 5 : 1 })
      },
      shotUrl: (target, s) => `${target}/${s.path}`,
      idle: async () => {},
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {},
    })
    // The latest timer is the pending walk.
    const flush = async (): Promise<void> => {
      timers.pop()?.()
      for (let i = 0; i < 40; i++) await Promise.resolve()
    }
    return { editor, out, jobs, flush, stop }
  }

  test('every locale and target is measured, and each overflow names its locale and target', async () => {
    const t = await setup()
    await t.flush()
    // en-US and fr-FR; ipad has no shot, so ios and android only.
    expect(t.jobs.length).toBe(4)
    expect(t.out.getState().measuring).toBe(false)
    expect(
      t.out
        .getState()
        .items.map((o) => `${o.locale}:${o.target}:${o.slideId}`)
        .sort(),
    ).toEqual(['fr-FR:android:a', 'fr-FR:ios:a'])
    expect(overflowsOf(t.out.getState().items, 'a').length).toBe(2)
    expect(overflowsOf(t.out.getState().items, 'zzz')).toEqual([])
    t.stop()
  })

  test('an edit re-measures only the slides it changed', async () => {
    const t = await setup()
    await t.flush()
    t.jobs.length = 0
    t.editor.getState().writeStyle({ section: 'headline', key: 'fontSize' }, 'all', 120)
    await t.flush()
    // The style changed every slide's resolved draw: all four are measured again, once each.
    expect(t.jobs.length).toBe(4)
    t.jobs.length = 0
    // A change that leaves every draw as it was measures nothing.
    t.editor.getState().setActiveSlide(0)
    t.editor.setState({ locale: 'fr-FR' })
    await t.flush()
    expect(t.jobs.length).toBe(0)
    t.stop()
  })

  test('a measure that throws is not an overflow and does not stop the walk', async () => {
    const t = await setup()
    t.stop()
    const out = createOverflowStore()
    const timers: (() => void)[] = []
    const stop = startOverflowMonitor(t.editor, out, {
      measure: async () => {
        throw new Error('no font')
      },
      shotUrl: (_t, s) => s.path,
      idle: async () => {},
      setTimer: (fn) => void timers.push(fn),
      clearTimer: () => {},
    })
    timers.pop()?.()
    for (let i = 0; i < 40; i++) await Promise.resolve()
    expect(out.getState()).toEqual({ items: [], measuring: false })
    stop()
  })
})
