import { create } from 'zustand'
import type { StudioSession, StudioShots } from '../../src/lib/storeshots/studio-api'
import type { Project } from '../../src/lib/storeshots/types'
import { getProject, getSession, getShots } from './api'
import { loadFonts } from './render/assets'

/**
 * The editor's state. Read-only for now; the shape is the one editing needs: `project` is the file
 * as loaded (edits will replace it, with undo stacks beside it), `loadedHash` is what a save sends
 * back to detect a change on disk.
 */

export type LoadState =
  | { status: 'loading' }
  /** A load failed. Never an editable default project: the user retries or leaves. */
  | { status: 'error'; message: string }
  | { status: 'ready' }

export interface EditorState {
  load: LoadState
  session: StudioSession | null
  /** The project file as loaded; `null` when the repo has none yet (or before the load finished). */
  project: Project | null
  /** The hash `project` was loaded with; `null` when there is no file. */
  loadedHash: string | null
  shots: StudioShots | null
  /** Index into the project's slides. */
  activeSlide: number
  locale: string

  /** Loads session, project and shots, then the fonts. Safe to call again as a retry. */
  loadAll: () => Promise<void>
  setActiveSlide: (index: number) => void
  setLocale: (locale: string) => void
}

/** The locales the editor can preview: the stores' metadata locales, then any the project has text for. */
export function localesOf(session: StudioSession, project: Project | null): string[] {
  const out: string[] = []
  const add = (code: string): void => void (out.includes(code) || out.push(code))
  for (const codes of Object.values(session.locales)) codes.forEach(add)
  for (const code of Object.keys(project?.locales ?? {})) add(code)
  return out.length > 0 ? out : ['en-US']
}

let loadToken = 0

export const useEditor = create<EditorState>((set, get) => ({
  load: { status: 'loading' },
  session: null,
  project: null,
  loadedHash: null,
  shots: null,
  activeSlide: 0,
  locale: 'en-US',

  async loadAll() {
    const mine = ++loadToken
    set({ load: { status: 'loading' } })
    try {
      const [session, file, shots] = await Promise.all([getSession(), getProject(), getShots()])
      // Fonts before the first draw: a canvas draws an unloaded face as the fallback, silently.
      await loadFonts(session.fonts)
      if (mine !== loadToken) return
      const project = file?.project ?? null
      const locales = localesOf(session, project)
      const { locale, activeSlide } = get()
      set({
        load: { status: 'ready' },
        session,
        project,
        loadedHash: file?.hash ?? null,
        shots,
        locale: locales.includes(locale) ? locale : locales[0]!,
        activeSlide: Math.min(activeSlide, Math.max(0, (project?.slides.length ?? 1) - 1)),
      })
    } catch (err) {
      if (mine !== loadToken) return
      set({ load: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
    }
  },
  setActiveSlide: (activeSlide) => set({ activeSlide }),
  setLocale: (locale) => set({ locale }),
}))
