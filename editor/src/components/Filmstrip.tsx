import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { StudioSession, StudioShots } from '../../../src/lib/storeshots/studio-api'
import type { Project } from '../../../src/lib/storeshots/types'
import { shotUrl } from '../api'
import { findShot, slidesFor } from '../slides'
import { useEditor } from '../store'
import { ShotPicker } from './ShotPicker'
import { SlideCanvas, type SlideDraw } from './SlideCanvas'

const THUMB_WIDTH = 84

interface Thumb {
  /** The slide's id: the key and the selection. */
  id: string
  name: string
  /** What the thumbnail draws: the first target that has a raw shot for the slide. */
  draw: SlideDraw | null
  size: { width: number; height: number }
}

/** One thumbnail per slide, from the first target that has its raw shot. */
function thumbs(
  project: Project,
  session: StudioSession,
  shots: StudioShots,
  locale: string,
  rev: number,
): Thumb[] {
  const perTarget = session.targets.map((target) => ({ target, slides: slidesFor(project, target, locale) }))
  const first = perTarget[0]
  if (!first) return []
  return first.slides.map((base, index): Thumb => {
    for (const { target, slides } of perTarget) {
      const slide = slides[index]
      const shot = slide && findShot(shots, target, slide, locale)
      if (slide && shot) {
        return {
          id: slide.id,
          name: slide.name,
          draw: { slide, shot: shotUrl(target, shot, rev), brand: session.brand },
          size: session.sets[target],
        }
      }
    }
    return { id: base.id, name: base.name, draw: null, size: session.sets[first.target] }
  })
}

export function Filmstrip() {
  const { project, session, shots, shotsRev, locale, activeSlide } = useEditor()
  const { setActiveSlide, deleteSlide, moveSlideTo, addSlideFromShot } = useEditor.getState()
  const editable = project?.version === 2
  const [adding, setAdding] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const items = useMemo(
    () => (project && session && shots ? thumbs(project, session, shots, locale, shotsRev) : []),
    [project, session, shots, locale, shotsRev],
  )

  return (
    <nav
      aria-label="Slides"
      className="flex w-[132px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-zinc-800 bg-zinc-900 p-2"
    >
      {items.map((item, index) => (
        <div
          key={item.id}
          draggable={editable}
          onDragStart={(e) => {
            setDragFrom(index)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            if (dragFrom === null) return
            e.preventDefault()
            setDropAt(index)
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (dragFrom !== null) moveSlideTo(dragFrom, index)
            setDragFrom(null)
            setDropAt(null)
          }}
          onDragEnd={() => {
            setDragFrom(null)
            setDropAt(null)
          }}
          className={`group relative rounded-md ${
            dropAt === index && dragFrom !== null && dragFrom !== index
              ? dragFrom < index
                ? 'border-b-2 border-sky-400'
                : 'border-t-2 border-sky-400'
              : ''
          } ${dragFrom === index ? 'opacity-40' : ''}`}
        >
          <button
            type="button"
            onClick={() => setActiveSlide(index)}
            onKeyDown={(e) => {
              if (!editable || !e.altKey) return
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                moveSlideTo(index, index + (e.key === 'ArrowUp' ? -1 : 1))
              }
            }}
            aria-current={index === activeSlide}
            aria-label={`${item.name}, slide ${index + 1} of ${items.length}${editable ? '. Alt and arrow keys reorder' : ''}`}
            className={`flex w-full flex-col items-center gap-1 rounded-md p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              index === activeSlide ? 'bg-sky-500/15 ring-1 ring-sky-500' : 'hover:bg-zinc-800'
            }`}
          >
            <SlideCanvas
              size={item.size}
              draw={item.draw}
              cssWidth={THUMB_WIDTH}
              empty={<span className="text-[9px] text-zinc-500">no shot</span>}
            />
            <span className="w-full truncate text-center text-[10px] text-zinc-400">{item.name}</span>
          </button>
          {editable && (
            <button
              type="button"
              aria-label={`Delete ${item.name}`}
              title="Delete slide (undoable)"
              onClick={() => deleteSlide(index)}
              className="absolute top-1.5 right-1.5 rounded bg-zinc-950/80 p-1 text-zinc-300 opacity-0 outline-none group-focus-within:opacity-100 group-hover:opacity-100 hover:text-red-300 focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              <Trash2 size={11} aria-hidden />
            </button>
          )}
        </div>
      ))}
      {editable && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1 flex items-center justify-center gap-1 rounded-md border border-dashed border-zinc-700 py-2 text-zinc-300 outline-none hover:border-zinc-500 hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <Plus size={13} aria-hidden /> Add slide
        </button>
      )}
      {adding && (
        <ShotPicker
          title="Add a slide from a raw shot"
          onClose={() => setAdding(false)}
          onPick={(file) => {
            addSlideFromShot(file)
            setAdding(false)
          }}
        />
      )}
    </nav>
  )
}
