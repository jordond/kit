import { Languages } from 'lucide-react'
import { localesOf, useEditor } from '../store'

export function Header() {
  const { session, project, locale, setLocale } = useEditor()
  const locales = session ? localesOf(session, project) : []

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3">
      <span className="font-medium text-zinc-100">Shots</span>
      {session && <code className="text-[11px] text-zinc-500">{session.projectPath}</code>}
      <div className="flex-1" />
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
