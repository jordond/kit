import { useStore } from 'zustand'
import * as api from './api'
import { loadFonts } from './render/assets'
import { createEditorStore, type EditorState } from './store-core'

export { baseShotFiles, localesOf, placeOf, type EditorState } from './store-core'

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
