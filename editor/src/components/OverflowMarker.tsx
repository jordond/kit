import { TriangleAlert } from 'lucide-react'
import type { DeviceTarget } from '../../../src/lib/devices'
import { type Overflow, overflowLabel } from '../overflow'

export const TARGET_NAME: Record<DeviceTarget, string> = { ios: 'iPhone', ipad: 'iPad', android: 'Android' }

/** The tooltip: one line per locale, target and reason. */
export const overflowTitle = (items: readonly Overflow[]): string =>
  ['Text overflows:', ...items.map((o) => overflowLabel(o, TARGET_NAME[o.target]))].join('\n')

/** A warning for a slide or a target column whose text overflows in some locale. Nothing when `items` is empty. */
export function OverflowMarker({ items, size = 12 }: { items: readonly Overflow[]; size?: number }) {
  if (items.length === 0) return null
  const title = overflowTitle(items)
  return (
    <span
      role="img"
      aria-label={title.replace('\n', ' ')}
      title={title}
      data-overflow={items.map((o) => `${o.locale}:${o.target}`).join(' ')}
      className="inline-flex text-amber-400"
    >
      <TriangleAlert size={size} aria-hidden />
    </span>
  )
}
