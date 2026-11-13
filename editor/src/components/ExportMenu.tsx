import { LoaderCircle, PackageCheck, X } from 'lucide-react'
import { useState } from 'react'
import type { Store } from '../../../src/lib/storeshots/sizes'
import type { StudioExportResult } from '../../../src/lib/storeshots/studio-api'
import { localesOf, useEditor } from '../store'

const STORE_LABEL: Record<Store, string> = { apple: 'App Store', google: 'Google Play' }
const BUTTON =
  'flex items-center gap-1 rounded px-1.5 py-1 text-zinc-300 outline-none enabled:hover:bg-zinc-800 enabled:hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-30'

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** What an export did, in words. */
export function summary(result: StudioExportResult): string {
  const parts = [`${count(result.written.length, 'file')} written`]
  if (result.removed.length > 0) parts.push(`${count(result.removed.length, 'file')} removed`)
  if (result.skipped.length > 0) parts.push(`${count(result.skipped.length, 'slide')} skipped`)
  return parts.join(', ')
}

function Result({ result }: { result: StudioExportResult }) {
  return (
    <div data-export-result className="flex flex-col gap-1">
      <p className="text-emerald-300">{summary(result)}</p>
      {result.written.length > 0 && (
        <details>
          <summary className="cursor-pointer text-zinc-400">Files written</summary>
          <ul className="mt-1 max-h-40 overflow-y-auto font-mono text-[10px] break-all text-zinc-400">
            {result.written.map((w) => (
              <li key={w.file}>{w.file}</li>
            ))}
          </ul>
        </details>
      )}
      {result.removed.length > 0 && (
        <details>
          <summary className="cursor-pointer text-zinc-400">Files removed</summary>
          <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px] break-all text-zinc-400">
            {result.removed.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
      )}
      {result.skipped.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-amber-300">Skipped</summary>
          <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px] break-all text-zinc-400">
            {result.skipped.map((s) => (
              <li key={`${s.store}${s.target}${s.locale}${s.slide}`}>
                {s.locale} {s.target} {s.slide}: {s.shot}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** The export button of the header: store and locale choice, progress, then the result or the error. */
export function ExportMenu() {
  const session = useEditor((s) => s.session)
  const project = useEditor((s) => s.project)
  const exporting = useEditor((s) => s.exporting)
  const conflict = useEditor((s) => s.conflict)
  const { runExport, dismissExport } = useEditor.getState()
  const [open, setOpen] = useState(false)
  const [stores, setStores] = useState<Record<Store, boolean>>({ apple: true, google: true })
  const [locale, setLocale] = useState('')

  if (!session || project?.version !== 2) return null
  const busy = exporting.status === 'saving' || exporting.status === 'running'
  const chosen = (['apple', 'google'] as const).filter((store) => stores[store])
  const locales = localesOf(session, project)

  return (
    <div className="relative">
      <button
        type="button"
        className={BUTTON}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        title="Render the slides into the store listing dirs, as kit shots export does"
      >
        {busy ? (
          <LoaderCircle size={14} className="animate-spin" aria-hidden />
        ) : (
          <PackageCheck size={14} aria-hidden />
        )}{' '}
        Export
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Export"
          className="absolute top-full right-0 z-20 mt-1 flex w-72 flex-col gap-2 rounded-md border border-zinc-700 bg-zinc-900 p-3 shadow-xl"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-zinc-100">Export to the store dirs</span>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-zinc-400 outline-none hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              <X size={13} aria-hidden />
            </button>
          </div>
          <fieldset className="flex flex-col gap-1" disabled={busy}>
            <legend className="mb-1 text-[10px] tracking-wide text-zinc-500 uppercase">Stores</legend>
            {(['apple', 'google'] as const).map((store) => (
              <label key={store} className="flex items-center gap-2 text-zinc-300">
                <input
                  type="checkbox"
                  checked={stores[store]}
                  onChange={(e) => setStores({ ...stores, [store]: e.target.checked })}
                  className="size-3.5 accent-sky-500"
                />
                {STORE_LABEL[store]}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center justify-between gap-2 text-zinc-300">
            Locales
            <select
              value={locale}
              disabled={busy}
              onChange={(e) => setLocale(e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              <option value="">All locales</option>
              {locales.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[10px] text-zinc-500">
            Unsaved changes are saved first. Missing raw shots stop the export, as in kit shots export.
          </p>
          <button
            type="button"
            data-export-run
            disabled={busy || conflict || chosen.length === 0}
            onClick={() => void runExport({ stores: chosen, ...(locale ? { locales: [locale] } : {}) })}
            className="rounded bg-sky-600 px-2 py-1 font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-sky-300 enabled:hover:bg-sky-500 disabled:opacity-40"
          >
            {exporting.status === 'saving'
              ? 'Saving…'
              : exporting.status === 'running'
                ? 'Exporting…'
                : 'Export'}
          </button>
          <div role="status" aria-live="polite" data-export-state={exporting.status}>
            {busy && (
              <p className="text-zinc-400">
                {exporting.status === 'saving' ? 'Saving the project first…' : 'Rendering in Chrome…'}
              </p>
            )}
            {exporting.status === 'done' && <Result result={exporting.result} />}
            {exporting.status === 'error' && (
              <p role="alert" className="break-words text-red-300">
                {exporting.message}
              </p>
            )}
          </div>
          {(exporting.status === 'done' || exporting.status === 'error') && (
            <button
              type="button"
              onClick={dismissExport}
              className="self-start text-[11px] text-zinc-400 underline outline-none hover:text-zinc-200"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  )
}
