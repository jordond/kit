import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPathKit } from '../../src/lib/doctor/checks'
import {
  globalInstaller,
  newerThan,
  readUpdateState,
  updateCheckOff,
  updateNotice,
  updateStateFile,
  writeUpdateState,
} from '../../src/lib/self-update'

const tmp = mkdtempSync(join(tmpdir(), 'kit-self-update-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const HOUR = 60 * 60 * 1000
const BUN_GLOBAL = '/Users/me/.bun/install/global/node_modules/@jordond/kit'

describe('the global kit', () => {
  test('globalInstaller reads the package manager from the global store path', () => {
    const command = (dir: string) => globalInstaller(dir)?.command('1.2.3').join(' ')
    expect(command(BUN_GLOBAL)).toBe('bun add -g @jordond/kit@1.2.3')
    expect(command('/opt/bun/install/global/node_modules/@jordond/kit')).toBe('bun add -g @jordond/kit@1.2.3')
    expect(
      command('/Users/me/Library/pnpm/global/5/.pnpm/@jordond+kit@0.8.0/node_modules/@jordond/kit'),
    ).toBe('pnpm add -g @jordond/kit@1.2.3')
    expect(command('/Users/me/.config/yarn/global/node_modules/@jordond/kit')).toBe(
      'yarn global add @jordond/kit@1.2.3',
    )
    expect(command('/opt/homebrew/lib/node_modules/@jordond/kit')).toBe('npm install -g @jordond/kit@1.2.3')
  })

  test('a checkout or a repo copy on PATH has no installer', () => {
    expect(globalInstaller('/Users/me/dev/kit')).toBeUndefined()
    expect(globalInstaller('/Users/me/dev/app/node_modules/@jordond/kit')).toBeUndefined()
    expect(globalInstaller('/Users/me/dev/app/.kit/node_modules/@jordond/kit')).toBeUndefined()
  })

  test('newerThan picks the newest candidate above the current version', () => {
    expect(newerThan('0.7.1', '0.8.1', '0.8.0')).toBe('0.8.1')
    expect(newerThan('0.7.1', undefined, '0.8.0')).toBe('0.8.0')
    expect(newerThan('0.8.1', '0.8.1', '0.7.0', undefined)).toBeUndefined()
    expect(newerThan('0.8.1', 'latest')).toBeUndefined()
  })

  test('update checks are off in CI and with KIT_NO_UPDATE_CHECK', () => {
    expect(updateCheckOff({})).toBe(false)
    expect(updateCheckOff({ CI: 'true' })).toBe(true)
    expect(updateCheckOff({ KIT_NO_UPDATE_CHECK: '1' })).toBe(true)
  })

  test('the state file lives in the cache dir and merges writes', () => {
    expect(updateStateFile({ KIT_CACHE_DIR: '/c' })).toBe('/c/update.json')
    expect(updateStateFile({ XDG_CACHE_HOME: '/x' })).toBe('/x/kit/update.json')
    const file = join(tmp, 'deep/update.json')
    expect(readUpdateState(file)).toEqual({})
    writeUpdateState({ latest: '0.8.1', checkedAt: 1 }, file)
    writeUpdateState({ notified: '0.8.1', notifiedAt: 2 }, file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      latest: '0.8.1',
      checkedAt: 1,
      notified: '0.8.1',
      notifiedAt: 2,
    })
  })
})

describe('the update notice', () => {
  const onPath = { dir: BUN_GLOBAL, version: '0.7.1' }
  const now = 10 * 24 * HOUR

  test('names npm’s latest, and asks npm again after a day', () => {
    expect(updateNotice({ running: '0.7.1', onPath, state: {}, now })).toEqual({ refresh: true })
    const state = { latest: '0.8.1', checkedAt: now - HOUR }
    expect(updateNotice({ running: '0.7.1', onPath, state, now })).toEqual({
      refresh: false,
      notice: { onPath: '0.7.1', latest: '0.8.1' },
    })
    expect(
      updateNotice({ running: '0.7.1', onPath, state: { ...state, checkedAt: now - 25 * HOUR }, now }),
    ).toMatchObject({ refresh: true })
  })

  test('a repo copy newer than the global kit is enough, with no lookup yet', () => {
    expect(updateNotice({ running: '0.8.0', onPath, state: {}, now }).notice).toEqual({
      onPath: '0.7.1',
      latest: '0.8.0',
    })
  })

  test('repeats once a day per version', () => {
    const state = { latest: '0.8.1', checkedAt: now, notified: '0.8.1', notifiedAt: now - HOUR }
    expect(updateNotice({ running: '0.7.1', onPath, state, now }).notice).toBeUndefined()
    expect(
      updateNotice({ running: '0.7.1', onPath, state: { ...state, notifiedAt: now - 25 * HOUR }, now })
        .notice,
    ).toBeDefined()
    expect(
      updateNotice({ running: '0.7.1', onPath, state: { ...state, latest: '0.9.0' }, now }).notice,
    ).toEqual({
      onPath: '0.7.1',
      latest: '0.9.0',
    })
  })

  test('silent when the global kit is current, missing, or not a global install', () => {
    const state = { latest: '0.8.1', checkedAt: now }
    expect(updateNotice({ running: '0.8.1', onPath: { ...onPath, version: '0.8.1' }, state, now })).toEqual({
      refresh: false,
    })
    expect(updateNotice({ running: '0.8.1', onPath: undefined, state: {}, now })).toEqual({ refresh: false })
    expect(
      updateNotice({
        running: '0.8.1',
        onPath: { dir: '/Users/me/dev/kit', version: '0.1.0' },
        state: {},
        now,
      }),
    ).toEqual({ refresh: false })
  })

  test('doctor warns when npm has a newer release than the kit on PATH', () => {
    expect(checkPathKit('0.7.1', '0.7.1', false, '0.8.1')).toMatchObject({
      status: 'warn',
      detail: '0.7.1, latest is 0.8.1',
      hint: 'kit upgrade --global',
    })
    // Older than the repo's kit is the more urgent finding.
    expect(checkPathKit('0.3.0', '0.7.1', true, '0.8.1')?.detail).toContain("older than this repo's 0.7.1")
  })
})
