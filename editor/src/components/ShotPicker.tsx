import { Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceTarget } from '../../../src/lib/devices'
import type { StudioShot } from '../../../src/lib/storeshots/studio-api'
import { ApiError, shotUrl } from '../api'
import { baseShotFiles, useEditor } from '../store'

interface Props {
  title: string
  /** The shot the slide has now, marked in the grid. */
  current?: string
  onPick: (file: string) => void
  onClose: () => void
}

/** Where a shot file can be seen: the first target that has it. */
function firstWith(
  shots: Record<DeviceTarget, StudioShot[]>,
  file: string,
): { target: DeviceTarget; shot: StudioShot } | undefined {
  for (const target of Object.keys(shots) as DeviceTarget[]) {
    const shot = shots[target].find((s) => !s.locale && s.file === file)
    if (shot) return { target, shot }
  }
  return undefined
}

/**
 * The raw shots, as thumbnails, to pick one for a slide; and an upload of a new PNG into the raw dir
 * of the target in focus. An upload over an existing file asks first.
 */
export function ShotPicker({ title, current, onPick, onClose }: Props) {
  const shots = useEditor((s) => s.shots)
  const rev = useEditor((s) => s.shotsRev)
  const target = useEditor((s) => s.target)
  const rawPath = useEditor((s) => s.session?.rawPath ?? 'raw')
  const project = useEditor((s) => s.project)
  const used = useMemo(
    () => new Set(project?.slides.map((s) => ('shot' in s ? s.shot : s.sourceFile))),
    [project],
  )
  const files = useMemo(
    () => (shots ? baseShotFiles(shots).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : []),
    [shots],
  )
  const [pending, setPending] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialog.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function upload(file: File, replace: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await useEditor.getState().uploadShot(file.name, file, { replace })
      setPending(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setPending(file)
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-6" role="presentation">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-2xl flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl outline-none"
      >
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-medium text-zinc-100">{title}</h2>
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 outline-none hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50"
          >
            <Upload size={13} aria-hidden /> Upload PNG
          </button>
          <input
            ref={input}
            type="file"
            accept="image/png"
            aria-label="PNG file to upload"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void upload(file, false)
            }}
          />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 outline-none hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <p className="text-[11px] text-zinc-500">
          A new PNG is saved in{' '}
          <code className="text-zinc-400">{`${rawPath.replace(/\/+$/, '')}/${target}/`}</code>, the raw folder
          of the focused target.
        </p>
        {pending && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded border border-amber-900/60 bg-amber-950/40 px-2 py-1.5 text-amber-100"
          >
            <span className="flex-1">
              <code>{pending.name}</code> already exists for {target}. Replace it?
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void upload(pending, true)}
              className="rounded bg-amber-200 px-2 py-0.5 font-medium text-amber-950 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded px-2 py-0.5 outline-none hover:bg-black/30 focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              Cancel
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
        {files.length === 0 ? (
          <p className="py-6 text-center text-zinc-500">No raw shots yet. Upload a PNG.</p>
        ) : (
          <ul className="grid min-h-0 grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 overflow-y-auto">
            {files.map((file) => {
              const where = shots ? firstWith(shots, file) : undefined
              return (
                <li key={file}>
                  <button
                    type="button"
                    onClick={() => onPick(file)}
                    aria-current={file === current}
                    className={`flex w-full flex-col items-center gap-1 rounded-md p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                      file === current ? 'bg-sky-500/15 ring-1 ring-sky-500' : 'hover:bg-zinc-800'
                    }`}
                  >
                    {where ? (
                      <img
                        src={shotUrl(where.target, where.shot, rev)}
                        alt=""
                        loading="lazy"
                        className="h-28 w-auto max-w-full rounded-[3px] object-contain ring-1 ring-white/10"
                      />
                    ) : (
                      <span className="h-28" />
                    )}
                    <span className="w-full truncate text-center text-[10px] text-zinc-300">{file}</span>
                    {used.has(file) && <span className="text-[9px] text-zinc-500">in use</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
