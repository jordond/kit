import type { DeviceTarget } from '../../src/lib/devices'
import type { SlideLayout } from '../../src/lib/storeshots/page/renderer'

/**
 * When a slide's text is too much for its canvas. Pure: the rule reads the `SlideLayout` the
 * renderer returns from a draw, so it never measures text itself.
 */

/** The thresholds of the rule, in one place. */
export const OVERFLOW_LIMITS = {
  /** A headline that wraps into more lines than this is too long. */
  maxHeadlineLines: 3,
  /** Text that ends below this fraction of the canvas height runs off the canvas. */
  textBottomMax: 1,
  /** The device may start no lower than this fraction of the canvas height when the text is what pushed it down. */
  deviceTopFloor: 0.55,
} as const

export type OverflowReason =
  | { kind: 'headline-lines'; lines: number }
  | { kind: 'off-canvas' }
  | { kind: 'device-pushed'; topPercent: number }

/** Why the layout overflows; empty when it does not. */
export function overflowReasons(layout: SlideLayout, limits = OVERFLOW_LIMITS): OverflowReason[] {
  const out: OverflowReason[] = []
  if (layout.headlineLines > limits.maxHeadlineLines) {
    out.push({ kind: 'headline-lines', lines: layout.headlineLines })
  }
  if (layout.textBottom > layout.height * limits.textBottomMax) out.push({ kind: 'off-canvas' })
  else if (layout.textPushesDevice && layout.device.y > layout.height * limits.deviceTopFloor) {
    out.push({ kind: 'device-pushed', topPercent: Math.round((layout.device.y / layout.height) * 100) })
  }
  return out
}

export function describeReason(reason: OverflowReason, limits = OVERFLOW_LIMITS): string {
  switch (reason.kind) {
    case 'headline-lines':
      return `the headline wraps to ${reason.lines} lines (more than ${limits.maxHeadlineLines})`
    case 'off-canvas':
      return 'the text runs off the canvas'
    case 'device-pushed':
      return `the text pushes the device down to ${reason.topPercent}% of the canvas (past ${Math.round(limits.deviceTopFloor * 100)}%)`
  }
}

/** One slide on one target in one locale that overflows. */
export interface Overflow {
  slideId: string
  target: DeviceTarget
  locale: string
  reasons: OverflowReason[]
}

/** The tooltip line for one overflow: names locale, target and reason. */
export function overflowLabel(o: Pick<Overflow, 'locale' | 'reasons'>, targetName: string): string {
  return `${o.locale} on ${targetName}: ${o.reasons.map((r) => describeReason(r)).join('; ')}`
}
