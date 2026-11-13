import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DeviceTarget } from '../../../src/lib/devices'
import { SCOPES, type Scope } from '../scope'
import { useEditor } from '../store'
import { STYLE_GROUPS } from './fields'
import { Presets } from './Presets'
import { SlideGroup } from './SlideGroup'
import { StyleField } from './StyleField'

export const TARGET_LABEL: Record<DeviceTarget, string> = { ios: 'iPhone', ipad: 'iPad', android: 'Android' }

const DESCRIPTION: Record<Scope, string> = {
  all: 'Edits apply to every slide on every target.',
  target: 'Edits apply to every slide on this target only.',
  slide: 'Edits apply to this slide on every target.',
  'slide-target': 'Edits apply to this slide on this target only.',
}

function ScopeSwitch() {
  const scope = useEditor((s) => s.scope)
  const target = useEditor((s) => s.target)
  const setScope = useEditor((s) => s.setScope)
  const label: Record<Scope, string> = {
    all: 'All slides',
    target: `This target`,
    slide: 'This slide',
    'slide-target': `This slide on ${TARGET_LABEL[target]}`,
  }
  return (
    <div className="flex flex-col gap-1.5 border-b border-zinc-800 p-3">
      <div className="flex items-baseline justify-between">
        <span id="scope-label" className="text-[11px] font-medium tracking-wide text-zinc-400 uppercase">
          Edit scope
        </span>
        <span className="text-[10px] text-zinc-500">{TARGET_LABEL[target]} in focus</span>
      </div>
      <div role="radiogroup" aria-labelledby="scope-label" className="grid grid-cols-2 gap-1">
        {SCOPES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={scope === value}
            onClick={() => setScope(value)}
            className={`rounded border px-2 py-1 text-left leading-tight outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              scope === value
                ? 'border-sky-500 bg-sky-500/15 text-sky-100'
                : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            {label[value]}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-zinc-500">{DESCRIPTION[scope]}</p>
    </div>
  )
}

function Section({ title, open, children }: { title: string; open: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group border-b border-zinc-800">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[11px] font-medium tracking-wide text-zinc-300 uppercase outline-none select-none hover:bg-zinc-800/50 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset">
        <ChevronDown size={12} aria-hidden className="transition-transform group-not-open:-rotate-90" />
        {title}
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  )
}

/** The editing panel: the scope switch, then the slide's content and every style field by group. */
export function Panel() {
  return (
    <aside
      aria-label="Slide settings"
      className="flex w-[300px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-900"
    >
      <ScopeSwitch />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Slide" open>
          <SlideGroup />
        </Section>
        <Section title="Presets" open={false}>
          <Presets />
        </Section>
        {STYLE_GROUPS.map((group) => (
          <Section key={group.id} title={group.title} open={group.open}>
            {group.blocks.map((block, i) => (
              <div key={block.title ?? i} className="flex flex-col">
                {block.title && <h3 className="pt-1 text-[11px] font-medium text-zinc-400">{block.title}</h3>}
                {block.fields.map((spec) => (
                  <StyleField
                    key={`${spec.field.section}.${spec.field.key}`}
                    spec={spec}
                    prefix={block.title}
                  />
                ))}
              </div>
            ))}
          </Section>
        ))}
      </div>
    </aside>
  )
}
