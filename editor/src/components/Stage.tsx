import { useMemo } from 'react'
import type { DeviceTarget } from '../../../src/lib/devices'
import { shotUrl } from '../api'
import { expectedShot, findShot, slidesFor } from '../slides'
import { useEditor } from '../store'
import { SlideCanvas } from './SlideCanvas'

const LABEL: Record<DeviceTarget, string> = { ios: 'iPhone', ipad: 'iPad', android: 'Android' }

/** One target's column: the active slide drawn for it, or what is missing to draw it. */
function TargetPreview({ target }: { target: DeviceTarget }) {
  const { project, session, shots, locale, activeSlide } = useEditor()
  const slides = useMemo(() => (project ? slidesFor(project, target, locale) : []), [project, target, locale])
  if (!session || !shots) return null

  const slide = slides[activeSlide]
  const shot = slide && findShot(shots, target, slide, locale)
  const set = session.sets[target]

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" aria-label={LABEL[target]}>
      <header className="flex items-baseline justify-between px-1 text-[11px] text-zinc-400">
        <span className="font-medium text-zinc-200">{LABEL[target]}</span>
        <span className="tabular-nums">
          {set.id} · {set.width}×{set.height}
        </span>
      </header>
      <div className="min-h-0 flex-1" data-target={target}>
        <SlideCanvas
          size={set}
          draw={slide && shot ? { slide, shot: shotUrl(target, shot), brand: session.brand } : null}
          empty={
            slide && (
              <div className="flex flex-col gap-1 text-[11px] text-zinc-400">
                <span className="text-zinc-300">No raw shot for this slide</span>
                <code className="text-[10px] break-all text-zinc-500">
                  {expectedShot(session, target, slide)}
                </code>
              </div>
            )
          }
        />
      </div>
      <footer className="truncate px-1 text-center text-[10px] text-zinc-500">
        {shot ? shot.path : (slide?.sourceFile ?? '')}
      </footer>
    </section>
  )
}

/** The active slide for every target of the session, side by side. */
export function Stage() {
  const targets = useEditor((s) => s.session?.targets ?? [])
  return (
    <main className="flex min-w-0 flex-1 gap-6 bg-zinc-950 p-5">
      {targets.map((target) => (
        <TargetPreview key={target} target={target} />
      ))}
    </main>
  )
}
