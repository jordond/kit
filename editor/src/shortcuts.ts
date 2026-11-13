import { useEffect } from 'react'
import { editorStore } from './store'

/**
 * Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redo, Cmd/Ctrl+S save now; and the `beforeunload`
 * guard while there is anything unsaved. Every edit lives in the store, so the browser's own text
 * undo is replaced by the store's, also inside the panel's inputs.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const state = editorStore.getState()
      if (state.project?.version !== 2) return
      if (key === 'z') {
        e.preventDefault()
        if (e.shiftKey) state.redo()
        else state.undo()
      } else if (key === 'y' && !e.metaKey) {
        e.preventDefault()
        state.redo()
      } else if (key === 's') {
        e.preventDefault()
        void state.save()
      }
    }
    const onUnload = (e: BeforeUnloadEvent): void => {
      const { dirty, saving } = editorStore.getState()
      if (dirty || saving) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
