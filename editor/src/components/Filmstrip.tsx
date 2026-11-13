import { useMemo } from 'react'
import type { StudioSession, StudioShots } from '../../../src/lib/storeshots/studio-api'
import type { Project } from '../../../src/lib/storeshots/types'
import { shotUrl } from '../api'
import { findShot, slidesFor } from '../slides'
import { useEditor } from '../store'
import { SlideCanvas, type SlideDraw } from './SlideCanvas'

const THUMB_WIDTH = 84

interface Thumb {
  name: string
  /** What the thumbnail draws: the first target that has a raw shot for the slide. */
  draw: SlideDraw | null
  size: { width: number; height: number }
}

/** One thumbnail per slide, from the first target that has its raw shot. */
function thumbs(project: Project, session: StudioSession, shots: StudioShots, locale: string): Thumb[] {
  const perTarget = session.targets.map((target) => ({ target, slides: slidesFor(project, target, locale) }))
  const first = perTarget[0]
  if (!first) return []
  return first.slides.map((base, index): Thumb => {
    for (const { target, slides } of perTarget) {
      const slide = slides[index]
      const shot = slide && findShot(shots, target, slide, locale)
      if (slide && shot) {
        return {
          name: slide.name,
          draw: { slide, shot: shotUrl(target, shot), brand: session.brand },
          size: session.sets[target],
        }
      }
    }
    return { name: base.name, draw: null, size: session.sets[first.target] }
  })
}

export function Filmstrip() {
  const { project, session, shots, locale, activeSlide, setActiveSlide } = useEditor()
  const items = useMemo(
    () => (project && session && shots ? thumbs(project, session, shots, locale) : []),
    [project, session, shots, locale],
  )

  return (
    <nav
      aria-label="Slides"
      className="flex w-[112px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-zinc-800 bg-zinc-900 p-2"
    >
      {items.map((item, index) => (
        <button
          // Slides are positional until editing gives them a stable identity.
          key={index}
          type="button"
          onClick={() => setActiveSlide(index)}
          aria-current={index === activeSlide}
          className={`flex flex-col items-center gap-1 rounded-md p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
            index === activeSlide ? 'bg-sky-500/15 ring-1 ring-sky-500' : 'hover:bg-zinc-800'
          }`}
        >
          <SlideCanvas
            size={item.size}
            draw={item.draw}
            cssWidth={THUMB_WIDTH}
            empty={<span className="text-[9px] text-zinc-500">no shot</span>}
          />
          <span className="w-full truncate text-center text-[10px] text-zinc-400">
            {index + 1}. {item.name}
          </span>
        </button>
      ))}
    </nav>
  )
}
