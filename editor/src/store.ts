import { useStore } from 'zustand'
import * as api from './api'
import { type OverflowState, createOverflowStore, startOverflowMonitor } from './overflow-monitor'
import { loadFonts } from './render/assets'
import { idle, measureLayout } from './render/measure'
import { createEditorStore, type EditorState } from './store-core'

export { baseShotFiles, type EditorState, localesOf, placeOf } from './store-core'

/** The editor's one store, wired to the real server, fonts and clock. */
export const editorStore = createEditorStore({
  api,
  loadFonts,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

/** The store as a hook: `useEditor((s) => s.project)`, or `useEditor()` for all of it. */
export function useEditor(): EditorState
export function useEditor<T>(selector: (state: EditorState) => T): T
export function useEditor<T>(selector?: (state: EditorState) => T) {
  return useStore(editorStore, selector ?? ((s) => s as unknown as T))
}

useEditor.getState = editorStore.getState

/** What overflows, found by the monitor `App` starts (`overflow-monitor.ts`). */
export const overflowStore = createOverflowStore()

export function useOverflow(): OverflowState {
  return useStore(overflowStore)
}

/** Starts the overflow monitor on the real store, a small offscreen draw and the browser's idle time. */
export function startMonitor(): () => void {
  return startOverflowMonitor(editorStore, overflowStore, {
    measure: measureLayout,
    shotUrl: api.shotUrl,
    idle,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
}
