import { Languages, Redo2, Save, Undo2 } from 'lucide-react'
import { localesOf, useEditor } from '../store'
import { ExportMenu } from './ExportMenu'

const BUTTON =
  'flex items-center gap-1 rounded px-1.5 py-1 text-zinc-300 outline-none enabled:hover:bg-zinc-800 enabled:hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-30'

/** What the save state says, in words. */
function status(s: { dirty: boolean; saving: boolean; conflict: boolean; saveError: unknown }): {
  text: string
  tone: string
} {
  if (s.conflict) return { text: 'Changed on disk', tone: 'text-amber-300' }
  if (s.saveError) return { text: 'Save failed', tone: 'text-red-300' }
  if (s.saving) return { text: 'Saving…', tone: 'text-zinc-400' }
  if (s.dirty) return { text: 'Unsaved changes', tone: 'text-zinc-300' }
  return { text: 'Saved', tone: 'text-zinc-500' }
}

export function Header() {
  const state = useEditor()
  const { session, project, locale, setLocale, undo, redo, save } = state
  const locales = session ? localesOf(session, project) : []
  const editable = project?.version === 2
  const st = status(state)

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3">
      <span className="font-medium text-zinc-100">Shots</span>
      {session && <code className="text-[11px] text-zinc-500">{session.projectPath}</code>}
      <div className="flex-1" />
      {editable && (
        <>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className={BUTTON}
              disabled={state.past.length === 0}
              onClick={undo}
              title="Undo (Ctrl or Cmd+Z)"
            >
              <Undo2 size={14} aria-hidden />
              <span className="sr-only">Undo</span>
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={state.future.length === 0}
              onClick={redo}
              title="Redo (Shift+Ctrl or Cmd+Z)"
            >
              <Redo2 size={14} aria-hidden />
              <span className="sr-only">Redo</span>
            </button>
          </div>
          <span role="status" aria-live="polite" className={`text-[11px] ${st.tone}`}>
            {st.text}
          </span>
          <button
            type="button"
            className={BUTTON}
            disabled={!state.dirty || state.saving || state.conflict}
            onClick={() => void save()}
            title="Save now (Ctrl or Cmd+S). Changes are also saved automatically."
          >
            <Save size={14} aria-hidden /> Save
          </button>
          <ExportMenu />
        </>
      )}
      <label className="flex items-center gap-1.5 text-zinc-400">
        <Languages size={14} aria-hidden />
        <span className="sr-only">Locale</span>
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          {locales.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </label>
    </header>
  )
}
