import { useEditor } from '../store'

/** The palette of `shots.palette` as swatches under a colour control; nothing when the config has none. */
export function Swatches({
  label,
  current,
  onPick,
}: {
  label: string
  /** The control's value, to mark the swatch that matches it. */
  current: string
  onPick: (color: string) => void
}) {
  const palette = useEditor((s) => s.session?.palette)
  if (!palette || palette.length === 0) return null
  return (
    <div role="group" aria-label={`${label} palette`} className="flex flex-wrap gap-1" data-palette>
      {palette.map((entry, i) => {
        const on = entry.color.toLowerCase() === current.trim().toLowerCase()
        return (
          <button
            key={`${entry.name ?? ''}${entry.color}${i}`}
            type="button"
            title={entry.name ? `${entry.name} ${entry.color}` : entry.color}
            aria-label={`Use ${entry.name ?? entry.color} for ${label}`}
            aria-pressed={on}
            onClick={() => onPick(entry.color)}
            className={`size-4 rounded-sm border outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              on ? 'border-sky-400 ring-1 ring-sky-400' : 'border-white/20'
            }`}
            style={{ background: entry.color }}
          />
        )
      })}
    </div>
  )
}
