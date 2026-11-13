import { createStore, type StoreApi } from 'zustand/vanilla'
import type { DeviceTarget } from '../../src/lib/devices'
import { slideId } from '../../src/lib/storeshots/resolve'
import type {
  StudioExportRequest,
  StudioExportResult,
  StudioProjectFile,
  StudioSave,
  StudioSaved,
  StudioSession,
  StudioShot,
  StudioShots,
} from '../../src/lib/storeshots/studio-api'
import type { PageFont, Project, ProjectV2, StyleRules } from '../../src/lib/storeshots/types'
import { applyPreset } from './presets'
import {
  addSlide,
  type ContentField,
  type FieldRef,
  type LocaleField,
  moveSlide,
  type Place,
  projectFromShots,
  promoteField,
  removeSlide,
  resetField,
  type Scope,
  setContent,
  setLocaleText,
  setShot,
  type StyleValue,
  writeField,
} from './scope'

/**
 * The editor's state and what changes it. No DOM, no React and no `fetch` in here: the server calls,
 * the font loader and the clock come in as `EditorDeps`, so a test drives the whole thing with
 * fakes. `store.ts` wires the real ones and the React hook.
 *
 * Edits go through `scope.ts` and replace `project` (never mutate it). `past` and `future` hold the
 * snapshots for undo and redo; an edit with a `coalesce` key joins the previous entry when it has the
 * same key and follows it closely, so a slider drag is one undo step. Saving is a queue of one:
 * a request in flight, and when it finishes the latest `project` goes next, so the newest state wins.
 */

export type LoadState =
  | { status: 'loading' }
  /** A load failed. Never an editable default project: the user retries or leaves. */
  | { status: 'error'; message: string }
  | { status: 'ready' }

/** A save that did not go through, other than a change on disk. */
export interface SaveError {
  message: string
  /** One line per bad field, on a 422. */
  issues?: string[]
}

export interface Snapshot {
  project: ProjectV2
  activeId: string | null
}

/** The calls the store makes; `api.ts` implements them. Errors carry a numeric `status` (409, 422). */
export interface EditorApi {
  getSession: () => Promise<StudioSession>
  getProject: () => Promise<StudioProjectFile | null>
  getShots: () => Promise<StudioShots>
  putProject: (save: StudioSave) => Promise<StudioSaved>
  exportShots: (request: StudioExportRequest) => Promise<StudioExportResult>
  uploadShot: (
    target: DeviceTarget,
    name: string,
    png: Blob,
    options: { replace?: boolean },
  ) => Promise<StudioShot>
}

export interface EditorDeps {
  api: EditorApi
  loadFonts: (fonts: PageFont[]) => Promise<void>
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Quiet time after an edit before it is saved. */
  autosaveMs?: number
  /** Edits with the same `coalesce` key closer together than this are one undo step (not a `gesture`). */
  coalesceMs?: number
}

export interface EditOptions {
  /** Edits with the same key in quick succession join one undo entry (a slider drag, typing). */
  coalesce?: string
  /** With `coalesce`: join the previous entry whatever the time between them. */
  untimed?: boolean
  /** The slide to select afterwards; default: the selected one, followed by id. */
  select?: string | null
}

/** The export the header started: saving the project first, running, then what came back. */
export type ExportState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'running' }
  | { status: 'done'; result: StudioExportResult }
  | { status: 'error'; message: string }

export interface EditorState {
  load: LoadState
  session: StudioSession | null
  /** The project as edited; `null` when the repo has none yet (or before the load finished). */
  project: Project | null
  /** The project as last loaded or saved: `project` differs from it exactly when `dirty`. */
  savedProject: Project | null
  /** The hash the file had when it was loaded or last saved; `null` when there is no file. */
  loadedHash: string | null
  shots: StudioShots | null
  /** Counts uploads: part of a shot's URL so a replaced PNG is fetched again. */
  shotsRev: number
  /** The selected slide by id (`slideId`): stable across reordering and edits elsewhere. */
  activeId: string | null
  /** The selected slide's position, kept in step with `activeId`. */
  activeSlide: number
  /** The target in focus: what "This target" means. */
  target: DeviceTarget
  locale: string
  scope: Scope
  past: Snapshot[]
  future: Snapshot[]
  dirty: boolean
  saving: boolean
  /** The file changed on disk since it was loaded: saving stops until Reload or Overwrite. */
  conflict: boolean
  saveError: SaveError | null
  exporting: ExportState

  loadAll: () => Promise<void>
  setActiveSlide: (index: number) => void
  setActiveId: (id: string) => void
  setTarget: (target: DeviceTarget) => void
  setLocale: (locale: string) => void
  setScope: (scope: Scope) => void

  /** Applies a preset's rules to the project's `style` in one undoable edit; see `applyPreset`. */
  applyPresetRules: (rules: StyleRules) => void
  /**
   * Writes several fields of one section at a scope as one edit. A `gesture` id joins every call
   * with the same id into one undo entry, however long the pause between them: a drag is one step.
   */
  writeStyles: (
    scope: Scope,
    writes: readonly { field: FieldRef; value: StyleValue }[],
    gesture?: string,
  ) => void
  /** Applies a change to the version 2 project. A version 1 project is never changed. */
  edit: (change: (project: ProjectV2) => ProjectV2, options?: EditOptions) => void
  writeStyle: (field: FieldRef, scope: Scope, value: StyleValue) => void
  resetStyle: (field: FieldRef, scope: Scope) => void
  promoteStyle: (field: FieldRef) => void
  setSlideContent: (field: ContentField, value: string) => void
  setLocaleContent: (locale: string, field: LocaleField, value: string) => void
  addSlideFromShot: (shot: string) => void
  deleteSlide: (index: number) => void
  moveSlideTo: (from: number, to: number) => void
  setSlideShot: (shot: string) => void
  undo: () => void
  redo: () => void

  /**
   * Saves what is unsaved, then runs the export on the server. Stops with an error when the save
   * does not go through, so an export never runs on a project older than the one on screen.
   */
  runExport: (request: StudioExportRequest) => Promise<void>
  dismissExport: () => void
  /** Saves now (cancelling a pending autosave); resolves when nothing is left to save or it failed. */
  save: () => Promise<void>
  /** After a 409: throw away the edits and load the file as it is on disk. */
  reloadFromDisk: () => Promise<void>
  /** After a 409: keep the edits and save over the file. */
  overwrite: () => Promise<void>
  dismissSaveError: () => void
  /** No project file yet: build one slide per raw shot and save it. */
  createProject: () => Promise<void>
  /** Uploads a PNG into the focused target's raw dir and refreshes the shot list. */
  uploadShot: (name: string, png: Blob, options?: { replace?: boolean }) => Promise<StudioShot>
}

const HISTORY_LIMIT = 200

/** The locales the editor can preview: the stores' metadata locales, then any the project has text for. */
export function localesOf(session: StudioSession, project: Project | null): string[] {
  const out: string[] = []
  const add = (code: string): void => void (out.includes(code) || out.push(code))
  for (const codes of Object.values(session.locales)) codes.forEach(add)
  for (const code of Object.keys(project?.locales ?? {})) add(code)
  return out.length > 0 ? out : ['en-US']
}

/** Every raw file that is a shared (not per-locale) shot of some target. */
export function baseShotFiles(shots: StudioShots): string[] {
  const files = Object.values(shots).flatMap((list) => list.filter((s) => !s.locale).map((s) => s.file))
  return [...new Set(files)]
}

/** Where a read or write of a style field is aimed: the selected slide on the focused target. */
export const placeOf = (state: Pick<EditorState, 'target' | 'activeSlide' | 'session'>): Place => ({
  target: state.target,
  slide: state.activeSlide,
  targets: state.session?.targets ?? [state.target],
})

const idAt = (project: Project | null, index: number): string | null => {
  const slide = project?.version === 2 ? project.slides[index] : undefined
  return slide ? slideId(slide) : null
}

/** The position of `id` in the project, else `fallback` clamped into range. */
function indexOfId(project: Project | null, id: string | null, fallback: number): number {
  const slides = project?.slides ?? []
  const found =
    id === null || project?.version !== 2 ? -1 : project.slides.findIndex((s) => slideId(s) === id)
  return found >= 0 ? found : Math.min(Math.max(fallback, 0), Math.max(0, slides.length - 1))
}

export function createEditorStore(deps: EditorDeps): StoreApi<EditorState> {
  const { api } = deps
  const autosaveMs = deps.autosaveMs ?? 800
  const coalesceMs = deps.coalesceMs ?? 1000

  let loadToken = 0
  let timer: unknown = null
  let running = false
  let lastKey: string | null = null
  let lastAt = 0
  let queue: Promise<void> = Promise.resolve()

  const store = createStore<EditorState>((set, get) => {
    const stopTimer = (): void => {
      if (timer !== null) deps.clearTimer(timer)
      timer = null
    }
    const scheduleSave = (): void => {
      stopTimer()
      if (get().conflict) return
      timer = deps.setTimer(() => {
        timer = null
        void get().save()
      }, autosaveMs)
    }

    /** Sets a new project and keeps `activeId`, `activeSlide` and `dirty` in step with it. */
    const adopt = (
      project: Project | null,
      activeId: string | null,
      extra: Partial<EditorState> = {},
    ): void => {
      const s = get()
      const activeSlide = indexOfId(project, activeId, s.activeSlide)
      set({
        project,
        activeSlide,
        activeId: idAt(project, activeSlide),
        dirty: project !== s.savedProject,
        ...extra,
      })
    }

    const restore = (from: 'past' | 'future'): void => {
      const s = get()
      const stack = s[from]
      const snap = stack[stack.length - 1]
      if (!snap || !s.project || s.project.version !== 2) return
      const here: Snapshot = { project: s.project, activeId: s.activeId }
      lastKey = null
      adopt(snap.project, snap.activeId, {
        past: from === 'past' ? stack.slice(0, -1) : [...s.past, here],
        future: from === 'past' ? [...s.future, here] : stack.slice(0, -1),
      })
      scheduleSave()
    }

    const run = async (): Promise<void> => {
      for (;;) {
        const s = get()
        const { project } = s
        if (!project || project.version !== 2 || project === s.savedProject || s.conflict) break
        set({ saving: true })
        try {
          const { hash } = await api.putProject({ project, hash: s.loadedHash })
          set({ loadedHash: hash, savedProject: project, saveError: null })
        } catch (err) {
          const status = (err as { status?: number }).status
          if (status === 409) set({ conflict: true })
          else {
            const issues = (err as { issues?: string[] }).issues
            set({
              saveError: {
                message: err instanceof Error ? err.message : String(err),
                ...(issues ? { issues } : {}),
              },
            })
          }
          break
        }
      }
      // Synchronously with the last check above: a save asked for after this starts a new run.
      running = false
      set({ saving: false, dirty: get().project !== get().savedProject })
    }

    return {
      load: { status: 'loading' },
      session: null,
      project: null,
      savedProject: null,
      loadedHash: null,
      shots: null,
      shotsRev: 0,
      activeId: null,
      activeSlide: 0,
      target: 'ios',
      locale: 'en-US',
      scope: 'all',
      past: [],
      future: [],
      dirty: false,
      saving: false,
      conflict: false,
      saveError: null,
      exporting: { status: 'idle' },

      async loadAll() {
        const mine = ++loadToken
        stopTimer()
        set({ load: { status: 'loading' } })
        try {
          const [session, file, shots] = await Promise.all([
            api.getSession(),
            api.getProject(),
            api.getShots(),
          ])
          // Fonts before the first draw: a canvas draws an unloaded face as the fallback, silently.
          await deps.loadFonts(session.fonts)
          if (mine !== loadToken) return
          const project = file?.project ?? null
          const locales = localesOf(session, project)
          const s = get()
          lastKey = null
          set({
            load: { status: 'ready' },
            session,
            shots,
            loadedHash: file?.hash ?? null,
            savedProject: project,
            past: [],
            future: [],
            conflict: false,
            saveError: null,
            saving: false,
            locale: locales.includes(s.locale) ? s.locale : locales[0]!,
            target: session.targets.includes(s.target) ? s.target : (session.targets[0] ?? s.target),
          })
          adopt(project, s.activeId)
        } catch (err) {
          if (mine !== loadToken) return
          set({ load: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
        }
      },

      setActiveSlide: (index) => adopt(get().project, idAt(get().project, index)),
      setActiveId: (id) => adopt(get().project, id),
      setTarget: (target) => set({ target }),
      setLocale: (locale) => set({ locale }),
      setScope: (scope) => set({ scope }),

      edit(change, options = {}) {
        const s = get()
        const { project } = s
        if (!project || project.version !== 2) return
        const next = change(project)
        if (next === project) return
        const now = deps.now()
        const joins =
          options.coalesce !== undefined &&
          options.coalesce === lastKey &&
          (options.untimed === true || now - lastAt < coalesceMs)
        lastKey = options.coalesce ?? null
        lastAt = now
        const past =
          joins && s.past.length > 0
            ? s.past
            : [...s.past, { project, activeId: s.activeId }].slice(-HISTORY_LIMIT)
        adopt(next, options.select !== undefined ? options.select : s.activeId, { past, future: [] })
        scheduleSave()
      },

      applyPresetRules(rules) {
        get().edit((p) => applyPreset(p, rules))
      },
      writeStyles(scope, writes, gesture) {
        const key = `gesture:${gesture}:${scope}:${get().activeId}:${get().target}`
        get().edit(
          (p) => writes.reduce((acc, w) => writeField(acc, scope, placeOf(get()), w.field, w.value), p),
          gesture === undefined ? undefined : { coalesce: key, untimed: true },
        )
      },
      writeStyle(field, scope, value) {
        const key = `style:${scope}:${get().activeId}:${get().target}:${field.section}.${field.key}`
        get().edit((p) => writeField(p, scope, placeOf(get()), field, value), { coalesce: key })
      },
      resetStyle(field, scope) {
        get().edit((p) => resetField(p, scope, placeOf(get()), field))
      },
      promoteStyle(field) {
        get().edit((p) => promoteField(p, placeOf(get()), field))
      },
      setSlideContent(field, value) {
        const index = get().activeSlide
        get().edit((p) => setContent(p, index, field, value), {
          coalesce: `content:${get().activeId}:${field}`,
        })
      },
      setLocaleContent(locale, field, value) {
        const id = get().activeId
        if (id === null) return
        get().edit((p) => setLocaleText(p, locale, id, field, value), {
          coalesce: `locale:${locale}:${id}:${field}`,
        })
      },
      addSlideFromShot(shot) {
        const s = get()
        if (!s.project || s.project.version !== 2) return
        const next = addSlide(s.project, shot)
        get().edit(() => next, { select: idAt(next, next.slides.length - 1) })
      },
      deleteSlide(index) {
        const s = get()
        if (!s.project || s.project.version !== 2) return
        const next = removeSlide(s.project, index)
        // The neighbour that takes its place, else the one before it.
        get().edit(() => next, { select: idAt(next, Math.min(index, next.slides.length - 1)) })
      },
      moveSlideTo(from, to) {
        get().edit((p) => moveSlide(p, from, to))
      },
      setSlideShot(shot) {
        const index = get().activeSlide
        const s = get()
        if (!s.project || s.project.version !== 2) return
        const next = setShot(s.project, index, shot)
        get().edit(() => next, { select: idAt(next, index) })
      },
      undo: () => restore('past'),
      redo: () => restore('future'),

      save() {
        stopTimer()
        if (!running) {
          running = true
          queue = run()
        }
        return queue
      },
      async reloadFromDisk() {
        await get().loadAll()
      },
      async overwrite() {
        // Take the hash of whatever is on disk now, keep our project, and save over it.
        const file = await api.getProject()
        set({ loadedHash: file?.hash ?? null, conflict: false, saveError: null })
        await get().save()
      },
      dismissSaveError: () => set({ saveError: null }),

      async runExport(request) {
        if (get().exporting.status === 'saving' || get().exporting.status === 'running') return
        set({ exporting: { status: 'saving' } })
        try {
          await get().save()
          const s = get()
          if (s.conflict || s.saveError || (s.project && s.project.version === 2 && s.dirty)) {
            set({
              exporting: {
                status: 'error',
                message: s.conflict
                  ? 'The project changed on disk: reload or overwrite, then export'
                  : `The project did not save${s.saveError ? ` (${s.saveError.message})` : ''}, so nothing was exported`,
              },
            })
            return
          }
          set({ exporting: { status: 'running' } })
          const result = await api.exportShots(request)
          set({ exporting: { status: 'done', result } })
        } catch (err) {
          set({ exporting: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
        }
      },
      dismissExport: () => {
        const status = get().exporting.status
        if (status !== 'saving' && status !== 'running') set({ exporting: { status: 'idle' } })
      },

      async createProject() {
        const s = get()
        if (s.project || !s.shots) return
        const files = baseShotFiles(s.shots)
        if (files.length === 0) return
        const project = projectFromShots(files)
        lastKey = null
        adopt(project, idAt(project, 0), { savedProject: null, loadedHash: null, past: [], future: [] })
        await get().save()
      },

      async uploadShot(name, png, options = {}) {
        const shot = await api.uploadShot(get().target, name, png, options)
        set({ shots: await api.getShots(), shotsRev: get().shotsRev + 1 })
        return shot
      },
    }
  })
  return store
}
