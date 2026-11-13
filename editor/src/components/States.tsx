import { AlertTriangle, FileQuestion, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6">{children}</div>
}

export const Loading = () => (
  <Centered>
    <span className="text-zinc-500">Loading…</span>
  </Centered>
)

/** A load failed: the message, and a retry. The editor never falls back to a default project. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Centered>
      <div
        role="alert"
        className="flex max-w-md flex-col items-start gap-3 rounded-lg border border-red-900/60 bg-red-950/30 p-4"
      >
        <div className="flex items-center gap-2 font-medium text-red-200">
          <AlertTriangle size={16} aria-hidden /> Could not load the project
        </div>
        <p className="break-words text-zinc-300">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded bg-zinc-100 px-2.5 py-1 font-medium text-zinc-900 hover:bg-white"
        >
          <RefreshCw size={13} aria-hidden /> Retry
        </button>
      </div>
    </Centered>
  )
}

/** The repo has no project file. */
export function NoProject({ path }: { path: string }) {
  return (
    <Centered>
      <div className="flex max-w-md flex-col items-start gap-2 text-zinc-300">
        <div className="flex items-center gap-2 font-medium text-zinc-100">
          <FileQuestion size={16} aria-hidden /> No project yet
        </div>
        <p>
          There is no project file at <code className="text-zinc-100">{path}</code>. Creating one from the raw
          shots is not available in the editor yet.
        </p>
      </div>
    </Centered>
  )
}

/** A version 1 project is shown, but not edited: it has to be migrated first. */
export function MigrateNotice() {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-amber-100">
      <AlertTriangle size={14} aria-hidden />
      <span>
        This is a version 1 project, shown read-only. Migrate it to edit:{' '}
        <code className="rounded bg-black/30 px-1 py-0.5 text-amber-50">kit shots migrate --write</code>
      </span>
    </div>
  )
}
