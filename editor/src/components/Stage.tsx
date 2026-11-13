import { Maximize2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DeviceTarget } from '../../../src/lib/devices'
import { shotUrl } from '../api'
import { overflowsOf } from '../overflow-monitor'
import { expectedShot, findShot, slidesFor } from '../slides'
import { useEditor, useOverflow } from '../store'
import { OverflowMarker, TARGET_NAME } from './OverflowMarker'
import { SlideCanvas } from './SlideCanvas'

/** One target's column: the active slide drawn for it, or what is missing to draw it. */
function TargetPreview({ target }: { target: DeviceTarget }) {
  const { project, session, shots, shotsRev, locale, activeSlide, target: focus, setTarget } = useEditor()
  const overflow = useOverflow().items
  const [actual, setActual] = useState(false)
  const slides = useMemo(() => (project ? slidesFor(project, target, locale) : []), [project, target, locale])
  if (!session || !shots) return null

  const slide = slides[activeSlide]
  const shot = slide && findShot(shots, target, slide, locale)
  const set = session.sets[target]
  const editable = project?.version === 2

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" aria-label={TARGET_NAME[target]}>
      <header className="flex items-center gap-1.5 px-1 text-[11px] text-zinc-400">
        <button
          type="button"
          aria-pressed={focus === target}
          title="Put this target in focus: This target and This slide on this target edit it"
          onClick={() => setTarget(target)}
          className={`rounded px-1.5 py-0.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
            focus === target ? 'bg-sky-500/20 text-sky-100' : 'text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          {TARGET_NAME[target]}
        </button>
        <OverflowMarker
          items={slide ? overflowsOf(overflow, slide.id).filter((o) => o.target === target) : []}
        />
        <span className="flex-1" />
        <span className="tabular-nums">
          {set.id} · {set.width}×{set.height}
        </span>
        <button
          type="button"
          aria-pressed={actual}
          data-actual-size={target}
          title={`Actual size: draw ${TARGET_NAME[target]} at ${set.width}×${set.height} in a scrollable view`}
          onClick={() => setActual(!actual)}
          className={`rounded p-1 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
            actual ? 'bg-sky-500/20 text-sky-100' : 'text-zinc-300 hover:bg-zinc-800'
          }`}
        >
          <Maximize2 size={12} aria-hidden />
          <span className="sr-only">Actual size</span>
        </button>
      </header>
      {/* A definite box: the canvas fits its height and width, and every column starts at the same top. */}
      <div className="relative min-h-0 flex-1" data-target={target}>
        <div
          className={`absolute inset-0 ${actual ? 'overflow-auto' : ''}`}
          data-scroll={actual || undefined}
        >
          <SlideCanvas
            size={set}
            actualSize={actual}
            manipulate={editable ? { target, label: TARGET_NAME[target] } : undefined}
            draw={
              slide && shot ? { slide, shot: shotUrl(target, shot, shotsRev), brand: session.brand } : null
            }
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
    <main className="flex min-h-0 min-w-0 flex-1 gap-6 bg-zinc-950 p-5">
      {targets.map((target) => (
        <TargetPreview key={target} target={target} />
      ))}
    </main>
  )
}
