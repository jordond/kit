import { AlertTriangle, X } from 'lucide-react'
import { useEditor } from '../store'

const BUTTON = 'rounded px-2 py-0.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-sky-500'

/** The file changed on disk: reload (drop the edits) or overwrite (keep them). */
export function ConflictBanner() {
  const conflict = useEditor((s) => s.conflict)
  const { reloadFromDisk, overwrite } = useEditor.getState()
  if (!conflict) return null
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-amber-100"
    >
      <AlertTriangle size={14} aria-hidden />
      <span className="flex-1">
        The project file changed on disk since it was loaded. Nothing is saved until you choose.
      </span>
      <button
        type="button"
        onClick={() => void reloadFromDisk()}
        className={`${BUTTON} border border-amber-700 hover:bg-black/30`}
        title="Load the file from disk and discard your edits"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => void overwrite()}
        className={`${BUTTON} bg-amber-200 text-amber-950 hover:bg-amber-100`}
        title="Save your edits over the file on disk"
      >
        Overwrite
      </button>
    </div>
  )
}

/** A save the server refused (422, with the bad fields) or that never arrived. */
export function SaveErrorBanner() {
  const error = useEditor((s) => s.saveError)
  const { dismissSaveError, save } = useEditor.getState()
  if (!error) return null
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-red-100"
    >
      <AlertTriangle size={14} aria-hidden className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>Could not save: {error.message}</span>
        {error.issues && (
          <ul className="list-disc pl-4 font-mono text-[11px] text-red-200">
            {error.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={() => void save()}
        className={`${BUTTON} border border-red-800 hover:bg-black/30`}
      >
        Retry
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismissSaveError}
        className="rounded p-1 outline-none hover:bg-black/30 focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  )
}
