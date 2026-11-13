import { beforeEach, describe, expect, test } from 'bun:test'
import { createEditorStore, type EditorApi, type EditorState } from '../../editor/src/store-core'
import { BUILT_IN_STYLE } from '../../src/lib/storeshots/resolve'
import type {
  StudioExportRequest,
  StudioSave,
  StudioSession,
  StudioShots,
} from '../../src/lib/storeshots/studio-api'
import type { Project, ProjectV2 } from '../../src/lib/storeshots/types'

const session: StudioSession = {
  projectPath: 'brand/studio.json',
  rawPath: 'raw',
  targets: ['ios', 'ipad', 'android'],
  sets: {} as StudioSession['sets'],
  locales: { apple: ['en-US'], google: ['en-US'] },
  fonts: [],
  brand: null,
  builtIn: BUILT_IN_STYLE,
  presets: {},
  palette: [],
}

const shot = (file: string) => ({ file, path: file, width: 10, height: 20 })
const shots: StudioShots = {
  ios: [shot('01-you.png'), shot('02-map.png')],
  ipad: [shot('01-you.png')],
  android: [],
}

const project = (): ProjectV2 => ({
  version: 2,
  slides: [
    { shot: '01-you.png', headline: 'You' },
    { shot: '02-map.png', headline: 'Map' },
  ],
})

class StatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: string[],
  ) {
    super(message)
  }
}

/** A fake server and a fake clock around one store. */
function setup(file: Project | null = project()) {
  let disk: Project | null = file
  let hash = file ? 'h1' : null
  let version = 1
  const puts: StudioSave[] = []
  const gates: (() => void)[] = []
  const fail: { next: Error | null; hold: boolean; exportNext: Error | null } = {
    next: null,
    hold: false,
    exportNext: null,
  }
  const exports: { request: StudioExportRequest; hash: string | null; disk: Project | null }[] = []
  const api: EditorApi = {
    getSession: async () => session,
    getProject: async () => (disk && hash ? { project: disk, hash } : null),
    getShots: async () => shots,
    putProject: async (save) => {
      puts.push(structuredClone(save))
      if (fail.hold) await new Promise<void>((ok) => gates.push(ok))
      if (fail.next) {
        const err = fail.next
        fail.next = null
        throw err
      }
      if (save.hash !== hash) throw new StatusError('changed on disk', 409)
      disk = save.project
      hash = `h${++version}`
      return { hash }
    },
    uploadShot: async (_t, name) => shot(name),
    exportShots: async (request) => {
      exports.push({ request, hash, disk })
      if (fail.exportNext) {
        const err = fail.exportNext
        fail.exportNext = null
        throw err
      }
      return { dryRun: false, stores: request.stores, written: [], removed: [], skipped: [] }
    },
  }
  const clock = { t: 0, timers: new Map<number, () => void>(), n: 0 }
  const store = createEditorStore({
    api,
    loadFonts: async () => {},
    now: () => clock.t,
    setTimer: (fn) => {
      clock.timers.set(++clock.n, fn)
      return clock.n
    },
    clearTimer: (h) => void clock.timers.delete(h as number),
  })
  const fireTimers = async (): Promise<void> => {
    const fns = [...clock.timers.values()]
    clock.timers.clear()
    for (const fn of fns) fn()
    await Promise.resolve()
  }
  return {
    store,
    puts,
    exports,
    clock,
    fail,
    gates,
    fireTimers,
    s: (): EditorState => store.getState(),
    disk: () => disk,
    setDisk(next: Project, nextHash: string) {
      disk = next
      hash = nextHash
    },
  }
}

const place = { section: 'device', key: 'scale' } as const

describe('loading', () => {
  test('a load gives the project, the first slide selected by id, nothing dirty', async () => {
    const t = setup()
    await t.s().loadAll()
    expect(t.s().load.status).toBe('ready')
    expect(t.s().activeId).toBe('you')
    expect(t.s().dirty).toBe(false)
  })

  test('a failed load is an error, not a default project', async () => {
    const failing = createEditorStore({
      api: {
        ...({} as EditorApi),
        getSession: async () => {
          throw new Error('down')
        },
        getProject: async () => null,
        getShots: async () => shots,
      },
      loadFonts: async () => {},
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
    })
    await failing.getState().loadAll()
    expect(failing.getState().load).toEqual({ status: 'error', message: 'down' })
    expect(failing.getState().project).toBeNull()
  })
})

describe('undo and redo', () => {
  let t: ReturnType<typeof setup>
  beforeEach(async () => {
    t = setup()
    await t.s().loadAll()
  })

  test('an edit is undone and redone', () => {
    t.s().writeStyle(place, 'all', 0.9)
    expect((t.s().project as ProjectV2).style).toEqual({ device: { scale: 0.9 } })
    t.s().undo()
    expect((t.s().project as ProjectV2).style).toBeUndefined()
    expect(t.s().dirty).toBe(false)
    t.s().redo()
    expect((t.s().project as ProjectV2).style).toEqual({ device: { scale: 0.9 } })
  })

  test('a slider drag (same field in quick succession) is one undo step', () => {
    for (const v of [0.5, 0.6, 0.7, 0.8]) {
      t.clock.t += 50
      t.s().writeStyle(place, 'all', v)
    }
    expect(t.s().past).toHaveLength(1)
    t.s().undo()
    expect((t.s().project as ProjectV2).style).toBeUndefined()
  })

  test('a pause, or another field, starts a new step', () => {
    t.s().writeStyle(place, 'all', 0.5)
    t.clock.t += 5000
    t.s().writeStyle(place, 'all', 0.6)
    t.s().writeStyle({ section: 'device', key: 'yOffset' }, 'all', 5)
    expect(t.s().past).toHaveLength(3)
  })

  test('a new edit clears redo', () => {
    t.s().writeStyle(place, 'all', 0.5)
    t.s().undo()
    expect(t.s().future).toHaveLength(1)
    t.s().writeStyle(place, 'all', 0.6)
    expect(t.s().future).toHaveLength(0)
  })

  test('delete is undoable and the selection returns to the slide', () => {
    t.s().setActiveId('map')
    t.s().deleteSlide(1)
    expect((t.s().project as ProjectV2).slides).toHaveLength(1)
    expect(t.s().activeId).toBe('you')
    t.s().undo()
    expect((t.s().project as ProjectV2).slides).toHaveLength(2)
    expect(t.s().activeId).toBe('map')
  })

  test('the selection follows the slide when slides are reordered', () => {
    t.s().setActiveId('you')
    t.s().moveSlideTo(0, 1)
    expect(t.s().activeSlide).toBe(1)
    expect(t.s().activeId).toBe('you')
  })

  test('a version 1 project is never changed', async () => {
    const v1 = { version: 1, platform: 'ios', slides: [] } as unknown as Project
    const old = setup(v1)
    await old.s().loadAll()
    old.s().writeStyle(place, 'all', 0.5)
    old.s().addSlideFromShot('x.png')
    expect(old.s().project).toBe(v1)
    expect(old.s().dirty).toBe(false)
  })
})

describe('presets', () => {
  test('a preset merges into the project style in one undoable edit', async () => {
    const t = setup({
      ...project(),
      style: { headline: { fontFamily: 'Serif', color: '#000000' }, device: { scale: 0.9 } },
    })
    await t.s().loadAll()
    t.s().applyPresetRules({ headline: { color: '#ffffff' }, background: { primaryColor: '#111111' } })
    expect((t.s().project as ProjectV2).style).toEqual({
      headline: { fontFamily: 'Serif', color: '#ffffff' },
      device: { scale: 0.9 },
      background: { primaryColor: '#111111' },
    })
    expect(t.s().past).toHaveLength(1)
    t.s().undo()
    expect((t.s().project as ProjectV2).style).toEqual({
      headline: { fontFamily: 'Serif', color: '#000000' },
      device: { scale: 0.9 },
    })
  })

  test('applying a preset the style already has changes nothing and adds no undo step', async () => {
    const t = setup()
    await t.s().loadAll()
    t.s().applyPresetRules({ headline: { color: '#ffffff' } })
    t.s().applyPresetRules({ headline: { color: '#ffffff' } })
    expect(t.s().past).toHaveLength(1)
  })
})

describe('writing several fields as one gesture', () => {
  const x = { section: 'device', key: 'xOffset' } as const
  const y = { section: 'device', key: 'yOffset' } as const

  test('x and y written together, over time, are one undo step', async () => {
    const t = setup()
    await t.s().loadAll()
    for (const [vx, vy] of [
      [1, 4],
      [2, 6],
      [3, 8],
    ] as const) {
      t.clock.t += 5000
      t.s().writeStyles(
        'all',
        [
          { field: x, value: vx },
          { field: y, value: vy },
        ],
        'drag-1',
      )
    }
    expect((t.s().project as ProjectV2).style).toEqual({ device: { xOffset: 3, yOffset: 8 } })
    expect(t.s().past).toHaveLength(1)
    // The next gesture is its own step.
    t.s().writeStyles('all', [{ field: x, value: 9 }], 'drag-2')
    expect(t.s().past).toHaveLength(2)
    t.s().undo()
    expect((t.s().project as ProjectV2).style).toEqual({ device: { xOffset: 3, yOffset: 8 } })
    t.s().undo()
    expect((t.s().project as ProjectV2).style).toBeUndefined()
  })

  test('the focused target and scope decide where it is written', async () => {
    const t = setup()
    await t.s().loadAll()
    t.s().setTarget('ipad')
    t.s().writeStyles('slide-target', [{ field: x, value: 5 }], 'g')
    expect((t.s().project as ProjectV2).slides[0]!.targets).toEqual({ ipad: { device: { xOffset: 5 } } })
  })
})

describe('export', () => {
  test('a dirty project is saved first, then exported, and the result is kept', async () => {
    const t = setup()
    await t.s().loadAll()
    t.s().writeStyle(place, 'all', 0.5)
    expect(t.s().dirty).toBe(true)
    await t.s().runExport({ stores: ['apple'], locales: ['en-US'] })
    expect(t.puts).toHaveLength(1)
    // The server saw the saved file, not the old one.
    expect(t.exports).toHaveLength(1)
    expect((t.exports[0]!.disk as ProjectV2).style).toEqual({ device: { scale: 0.5 } })
    expect(t.exports[0]!.request).toEqual({ stores: ['apple'], locales: ['en-US'] })
    expect(t.s().exporting).toEqual({
      status: 'done',
      result: { dryRun: false, stores: ['apple'], written: [], removed: [], skipped: [] },
    })
    t.s().dismissExport()
    expect(t.s().exporting).toEqual({ status: 'idle' })
  })

  test('a save that fails stops the export', async () => {
    const t = setup()
    await t.s().loadAll()
    t.s().writeStyle(place, 'all', 0.5)
    t.fail.next = new StatusError('invalid', 422, ['slides.0: bad'])
    await t.s().runExport({ stores: ['apple'] })
    expect(t.exports).toHaveLength(0)
    expect(t.s().exporting).toMatchObject({ status: 'error' })
    expect((t.s().exporting as { message: string }).message).toContain('nothing was exported')
  })

  test('a change on disk stops the export and says so', async () => {
    const t = setup()
    await t.s().loadAll()
    t.setDisk(project(), 'other')
    t.s().writeStyle(place, 'all', 0.5)
    await t.s().runExport({ stores: ['apple'] })
    expect(t.exports).toHaveLength(0)
    expect((t.s().exporting as { message: string }).message).toContain('changed on disk')
  })

  test('an export that fails keeps the server message', async () => {
    const t = setup()
    await t.s().loadAll()
    t.fail.exportNext = new Error('Chrome not found')
    await t.s().runExport({ stores: ['google'] })
    expect(t.s().exporting).toEqual({ status: 'error', message: 'Chrome not found' })
  })

  test('an export already running is not started twice', async () => {
    const t = setup()
    await t.s().loadAll()
    const first = t.s().runExport({ stores: ['apple'] })
    const second = t.s().runExport({ stores: ['apple'] })
    await Promise.all([first, second])
    expect(t.exports).toHaveLength(1)
  })
})

describe('saving', () => {
  test('an edit is saved after the quiet time, with the loaded hash, and is no longer dirty', async () => {
    const t = setup()
    await t.s().loadAll()
    t.s().writeStyle(place, 'all', 0.9)
    expect(t.s().dirty).toBe(true)
    expect(t.puts).toHaveLength(0)
    await t.fireTimers()
    await t.s().save()
    expect(t.puts).toHaveLength(1)
    expect(t.puts[0]!.hash).toBe('h1')
    expect(t.s().dirty).toBe(false)
    expect(t.s().loadedHash).toBe('h2')
    expect((t.disk() as ProjectV2).style).toEqual({ device: { scale: 0.9 } })
  })

  test('edits during a save: one request in flight, the latest state goes next', async () => {
    const t = setup()
    await t.s().loadAll()
    t.fail.hold = true
    t.s().writeStyle(place, 'all', 0.5)
    const first = t.s().save()
    await Promise.resolve()
    expect(t.s().saving).toBe(true)
    t.clock.t += 5000
    t.s().writeStyle(place, 'all', 0.6)
    t.clock.t += 5000
    t.s().writeStyle(place, 'all', 0.7)
    void t.s().save()
    void t.s().save()
    expect(t.puts).toHaveLength(1)
    t.fail.hold = false
    t.gates.shift()!()
    await first
    expect(t.puts).toHaveLength(2)
    expect((t.puts[1]!.project as ProjectV2).style).toEqual({ device: { scale: 0.7 } })
    expect(t.puts[1]!.hash).toBe('h2')
    expect(t.s().dirty).toBe(false)
    expect(t.s().saving).toBe(false)
  })

  test('409 stops saving and flags the conflict; autosave stays quiet', async () => {
    const t = setup()
    await t.s().loadAll()
    t.setDisk({ ...project(), slides: [] }, 'other')
    t.s().writeStyle(place, 'all', 0.9)
    await t.s().save()
    expect(t.s().conflict).toBe(true)
    expect(t.s().dirty).toBe(true)
    expect(t.s().saving).toBe(false)
    t.clock.t += 5000
    t.s().writeStyle(place, 'all', 0.8)
    expect(t.clock.timers.size).toBe(0)
    expect(t.puts).toHaveLength(1)
  })

  test('overwrite saves the edits over what is on disk', async () => {
    const t = setup()
    await t.s().loadAll()
    t.setDisk(project(), 'other')
    t.s().writeStyle(place, 'all', 0.9)
    await t.s().save()
    await t.s().overwrite()
    expect(t.s().conflict).toBe(false)
    expect(t.s().dirty).toBe(false)
    expect(t.puts.at(-1)!.hash).toBe('other')
    expect((t.disk() as ProjectV2).style).toEqual({ device: { scale: 0.9 } })
  })

  test('reload from disk drops the edits and the history', async () => {
    const t = setup()
    await t.s().loadAll()
    const theirs = { ...project(), slides: [{ shot: '09-x.png', headline: 'X' }] }
    t.setDisk(theirs, 'other')
    t.s().writeStyle(place, 'all', 0.9)
    await t.s().save()
    await t.s().reloadFromDisk()
    expect(t.s().conflict).toBe(false)
    expect(t.s().project).toEqual(theirs)
    expect(t.s().loadedHash).toBe('other')
    expect(t.s().past).toHaveLength(0)
    expect(t.s().dirty).toBe(false)
  })

  test('422 keeps the issues and the edits; the next edit tries again', async () => {
    const t = setup()
    await t.s().loadAll()
    t.fail.next = new StatusError('Invalid project', 422, ['slides.0.shot: Too small'])
    t.s().writeStyle(place, 'all', 0.9)
    await t.s().save()
    expect(t.s().saveError).toEqual({ message: 'Invalid project', issues: ['slides.0.shot: Too small'] })
    expect(t.s().dirty).toBe(true)
    expect(t.s().conflict).toBe(false)
    t.clock.t += 5000
    t.s().writeStyle(place, 'all', 0.8)
    await t.s().save()
    expect(t.s().saveError).toBeNull()
    expect(t.s().dirty).toBe(false)
  })

  test('a network failure is an error with no issues', async () => {
    const t = setup()
    await t.s().loadAll()
    t.fail.next = new StatusError('Could not reach the kit server', 0)
    t.s().writeStyle(place, 'all', 0.9)
    await t.s().save()
    expect(t.s().saveError).toEqual({ message: 'Could not reach the kit server' })
  })

  test('undoing back to the saved state is not dirty', async () => {
    const t = setup()
    await t.s().loadAll()
    t.s().writeStyle(place, 'all', 0.9)
    t.s().undo()
    expect(t.s().dirty).toBe(false)
  })
})

describe('creating a project', () => {
  test('one slide per raw shot, saved only when asked, with no hash', async () => {
    const t = setup(null)
    await t.s().loadAll()
    expect(t.s().project).toBeNull()
    await t.s().createProject()
    expect((t.s().project as ProjectV2).slides.map((s) => s.shot)).toEqual(['01-you.png', '02-map.png'])
    expect(t.puts).toHaveLength(1)
    expect(t.puts[0]!.hash).toBeNull()
    expect(t.s().dirty).toBe(false)
  })

  test('a project is not created over an existing one', async () => {
    const t = setup()
    await t.s().loadAll()
    await t.s().createProject()
    expect(t.puts).toHaveLength(0)
  })
})
