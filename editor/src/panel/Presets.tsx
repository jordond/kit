import { useMemo } from 'react'
import { type PresetItem, presetList } from '../presets'
import { useEditor } from '../store'

/** A small sample of what a preset does to the background: its two background colours. */
function Sample({ preset }: { preset: PresetItem }) {
  const bg = preset.rules.background
  const from = bg?.primaryColor ?? '#ffffff'
  const to = bg?.secondaryColor ?? from
  const text = preset.rules.headline?.color ?? '#111111'
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded border border-white/10 text-[10px] font-bold"
      style={{ background: `linear-gradient(160deg, ${from}, ${to})`, color: text }}
    >
      Aa
    </span>
  )
}

/** The presets of kit and of the repo: each applies its rules to the All slides style in one undoable edit. */
export function Presets() {
  const repo = useEditor((s) => s.session?.presets)
  const applyPresetRules = useEditor((s) => s.applyPresetRules)
  const items = useMemo(() => presetList(repo ?? {}), [repo])
  return (
    <div className="flex flex-col gap-1.5" data-presets>
      <p className="text-[10px] text-zinc-500">
        A preset sets the fields it names in the All slides style and keeps the rest. Overrides on a target or
        a slide still win. Undo restores the style.
      </p>
      <div className="grid grid-cols-2 gap-1">
        {items.map((preset) => (
          <button
            key={preset.name}
            type="button"
            data-preset={preset.name}
            title={preset.fromRepo ? 'From kit.config.ts' : 'Built in'}
            onClick={() => applyPresetRules(preset.rules)}
            className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-left text-zinc-200 outline-none hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            <Sample preset={preset} />
            <span className="min-w-0 truncate">{preset.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
