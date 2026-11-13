import { ArrowUpToLine, RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'
import { hasOverride, readField, type Source, type StyleValue } from '../scope'
import { useEditor } from '../store'
import { type FieldSpec, GENERIC_FONTS, type Option } from './fields'

const INPUT =
  'rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-sky-500'

const SOURCE: Record<Source, { label: string; title: string; tone: string }> = {
  'built-in': { label: 'default', title: 'The built-in value', tone: 'bg-zinc-800 text-zinc-400' },
  project: { label: 'all', title: 'Set for all slides', tone: 'bg-sky-500/20 text-sky-300' },
  target: { label: 'target', title: 'Set for this target', tone: 'bg-violet-500/20 text-violet-300' },
  slide: { label: 'slide', title: 'Set for this slide', tone: 'bg-amber-500/20 text-amber-300' },
  'slide-target': {
    label: 'slide + target',
    title: 'Set for this slide on this target',
    tone: 'bg-emerald-500/20 text-emerald-300',
  },
}

/** Where a value comes from, as a small marker. */
export function SourceMarker({ source }: { source: Source }) {
  const s = SOURCE[source]
  return (
    <span title={s.title} className={`rounded px-1 text-[9px] leading-4 uppercase ${s.tone}`}>
      {s.label}
    </span>
  )
}

/** `#rrggbb` for the colour swatch when the value is a hex colour; `null` for anything else (`rgba(...)`). */
function toHex(value: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return null
  const hex = m[1]!
  return `#${(hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex).toLowerCase()}`
}

const validColour = (value: string): boolean => typeof CSS === 'undefined' || CSS.supports('color', value)

interface ControlProps {
  id: string
  label: string
  spec: FieldSpec['control']
  value: StyleValue
  onChange: (value: StyleValue) => void
  /** Offered fonts, for the font control. */
  fonts: string[]
}

function Control({ id, label, spec, value, onChange, fonts }: ControlProps) {
  const [draft, setDraft] = useState<string | null>(null)
  switch (spec.kind) {
    case 'number': {
      const num = typeof value === 'number' ? value : undefined
      return (
        <div className="flex items-center gap-2">
          {!spec.optional && (
            <input
              type="range"
              aria-label={`${label} slider`}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={num ?? spec.min}
              onChange={(e) => onChange(Number(e.target.value))}
              className="min-w-0 flex-1 accent-sky-500"
            />
          )}
          <input
            id={id}
            type="number"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={num ?? ''}
            placeholder={spec.optional ? 'auto' : undefined}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            className={`${INPUT} w-16 text-right tabular-nums`}
          />
          {spec.unit && <span className="w-3 text-[10px] text-zinc-500">{spec.unit}</span>}
        </div>
      )
    }
    case 'color': {
      const text = typeof value === 'string' ? value : ''
      const hex = toHex(text)
      return (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} picker`}
            value={hex ?? '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className={`h-6 w-8 cursor-pointer rounded border border-zinc-700 bg-zinc-800 p-0.5 ${hex ? '' : 'opacity-50'}`}
          />
          <input
            id={id}
            type="text"
            spellCheck={false}
            value={draft ?? text}
            aria-invalid={draft !== null && !validColour(draft)}
            onChange={(e) => {
              setDraft(e.target.value)
              if (e.target.value.trim() !== '' && validColour(e.target.value)) onChange(e.target.value.trim())
            }}
            onBlur={() => setDraft(null)}
            className={`${INPUT} min-w-0 flex-1 font-mono text-[11px]`}
          />
        </div>
      )
    }
    case 'toggle':
      return (
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 accent-sky-500"
        />
      )
    case 'font': {
      const current = typeof value === 'string' ? value : ''
      const list = fonts.includes(current) || current === '' ? fonts : [current, ...fonts]
      return (
        <select id={id} value={current} onChange={(e) => onChange(e.target.value)} className={INPUT}>
          {list.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>
      )
    }
    case 'select': {
      const current = typeof value === 'string' ? value : ''
      const choices: Option[] = [...spec.options]
      if (current !== '' && !choices.some((o) => o.value === current)) {
        choices.unshift({ value: current, label: current })
      }
      return (
        <select
          id={id}
          value={current}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={INPUT}
        >
          {spec.auto !== undefined && <option value="">{spec.auto}</option>}
          {choices.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    }
    case 'segmented':
      return (
        <div
          role="radiogroup"
          aria-label={label}
          className="flex overflow-hidden rounded border border-zinc-700"
        >
          {spec.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={value === o.value}
              onClick={() => onChange(o.value)}
              className={`flex-1 px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset ${
                value === o.value
                  ? 'bg-sky-500/25 text-sky-100'
                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )
  }
}

/**
 * One style field: its label, where its value comes from, a reset of the override at the current
 * scope, and (on This slide) a button that moves the override to all slides.
 */
export function StyleField({ spec, prefix }: { spec: FieldSpec; prefix?: string }) {
  const id = useId()
  const project = useEditor((s) => (s.project?.version === 2 ? s.project : null))
  const scope = useEditor((s) => s.scope)
  const target = useEditor((s) => s.target)
  const slide = useEditor((s) => s.activeSlide)
  const targets = useEditor((s) => s.session?.targets)
  const sessionFonts = useEditor((s) => s.session?.fonts)
  const { writeStyle, resetStyle, promoteStyle } = useEditor.getState()
  if (!project) return null

  const place = { target, slide, targets: targets ?? [target] }
  const { value, source } = readField(project, place, spec.field)
  const overridden = hasOverride(project, scope, place, spec.field)
  const label = prefix ? `${prefix} ${spec.label.toLowerCase()}` : spec.label
  const fonts = [...new Set([...(sessionFonts ?? []).map((f) => f.family), ...GENERIC_FONTS])]

  return (
    <div className="flex flex-col gap-1 py-1" data-field={`${spec.field.section}.${spec.field.key}`}>
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="flex-1 text-zinc-300">
          {spec.label}
        </label>
        <SourceMarker source={source} />
        {scope === 'slide' && overridden && (
          <button
            type="button"
            title="Use this for all slides"
            aria-label={`Use ${label} for all slides`}
            onClick={() => promoteStyle(spec.field)}
            className="rounded p-0.5 text-zinc-400 outline-none hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            <ArrowUpToLine size={12} aria-hidden />
          </button>
        )}
        <button
          type="button"
          title="Remove the override at this scope"
          aria-label={`Reset ${label}`}
          disabled={!overridden}
          onClick={() => resetStyle(spec.field, scope)}
          className="rounded p-0.5 text-zinc-400 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 enabled:hover:bg-zinc-800 enabled:hover:text-zinc-100 disabled:opacity-25"
        >
          <RotateCcw size={12} aria-hidden />
        </button>
      </div>
      <Control
        id={id}
        label={label}
        spec={spec.control}
        value={value}
        fonts={fonts}
        onChange={(next) =>
          next === undefined ? resetStyle(spec.field, scope) : writeStyle(spec.field, scope, next)
        }
      />
    </div>
  )
}
