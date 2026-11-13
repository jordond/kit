import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { compareVersions, pathKit } from './kit-copy'
import { isVersion, KIT_PACKAGE, latestVersion } from './kitref'

/**
 * The global kit (the `kit` on PATH): which package manager installed it, whether a newer release
 * is out, and the once-a-day notice about it. `kit upgrade` moves a repo's pin; `kit upgrade
 * --global` moves this one.
 */

export type GlobalPm = 'bun' | 'pnpm' | 'yarn' | 'npm'

export interface GlobalInstaller {
  pm: GlobalPm
  /** The command that installs `version` over the global copy. */
  command(version: string): string[]
}

const INSTALL: Record<GlobalPm, string[]> = {
  bun: ['bun', 'add', '-g'],
  pnpm: ['pnpm', 'add', '-g'],
  yarn: ['yarn', 'global', 'add'],
  npm: ['npm', 'install', '-g'],
}

/**
 * The package manager that owns the global kit at `dir` (its real path), read from where its global
 * store puts packages. Undefined for a copy no global install made: a source checkout linked onto
 * PATH, or a repo's own `node_modules`.
 */
export function globalInstaller(dir: string): GlobalInstaller | undefined {
  const path = dir.replaceAll('\\', '/')
  if (!path.endsWith(`/node_modules/${KIT_PACKAGE}`)) return undefined
  const pm: GlobalPm | undefined = path.includes('/install/global/node_modules/')
    ? 'bun'
    : /\/\.?pnpm\//.test(path)
      ? 'pnpm'
      : path.includes('/yarn/global/')
        ? 'yarn'
        : path.endsWith(`/lib/node_modules/${KIT_PACKAGE}`)
          ? 'npm'
          : undefined
  return pm && { pm, command: (version) => [...INSTALL[pm], `${KIT_PACKAGE}@${version}`] }
}

/** The newest of `candidates` that is newer than `current`; undefined when `current` is up to date. */
export function newerThan(current: string, ...candidates: (string | undefined)[]): string | undefined {
  let best: string | undefined
  for (const c of candidates) {
    if (c && isVersion(c) && compareVersions(c, best ?? current) > 0) best = c
  }
  return best
}

/** No update checks in CI, or when `KIT_NO_UPDATE_CHECK` is set. */
export const updateCheckOff = (env: Record<string, string | undefined> = process.env): boolean =>
  env.CI === 'true' || env.CI === '1' || Boolean(env.KIT_NO_UPDATE_CHECK)

/** What kit remembers between runs about its own releases. */
export interface UpdateState {
  /** The latest version on npm at `checkedAt`. */
  latest?: string
  /** When npm was last asked (ms), whether or not it answered. */
  checkedAt?: number
  /** The version the last notice named, and when it was shown (ms). */
  notified?: string
  notifiedAt?: number
}

export const updateStateFile = (env: Record<string, string | undefined> = process.env): string =>
  join(env.KIT_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'kit'), 'update.json')

export function readUpdateState(file = updateStateFile()): UpdateState {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return state && typeof state === 'object' ? (state as UpdateState) : {}
  } catch {
    return {}
  }
}

/** Merge `patch` into the state file. Best effort: a read-only home never fails a command. */
export function writeUpdateState(patch: UpdateState, file = updateStateFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ ...readUpdateState(file), ...patch })}\n`)
  } catch {}
}

const DAY = 24 * 60 * 60 * 1000

/** The hidden argument a kit child runs with to refresh the state file (see `refreshUpdateState`). */
export const REFRESH_ARG = '__refresh-update-state'

/** Ask npm for the latest version and record the answer; a failed lookup still counts as a check. */
export async function refreshUpdateState(now = Date.now()): Promise<void> {
  const latest = await latestVersion(10_000)
  writeUpdateState({ checkedAt: now, ...(latest ? { latest } : {}) })
}

/** Refresh the state file from a child that outlives this run, so no command waits on the network. */
function refreshInBackground(): void {
  const entry = process.argv[1]
  if (!entry) return
  try {
    Bun.spawn([process.execPath, '--no-env-file', entry, REFRESH_ARG], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    }).unref()
  } catch {}
}

export interface UpdateNotice {
  onPath: string
  latest: string
}

/** What `updateNotice` decides from; the defaults read the real machine. */
export interface NoticeInput {
  /** The version of the kit that is running (a repo's copy can be newer than the global one). */
  running: string
  onPath: { dir: string; version: string } | undefined
  state: UpdateState
  now: number
}

/**
 * Whether to tell the user the global kit is behind, and whether npm is due another look. The
 * notice names the newest version kit knows of (npm's latest, or the running copy), and repeats
 * at most once a day per version. A global kit no package manager installed is never judged.
 */
export function updateNotice(input: NoticeInput): { notice?: UpdateNotice; refresh: boolean } {
  const { onPath, state, now } = input
  if (!onPath || !globalInstaller(onPath.dir)) return { refresh: false }
  const refresh = state.checkedAt === undefined || now - state.checkedAt >= DAY
  const latest = newerThan(onPath.version, state.latest, input.running)
  const shownToday =
    state.notified === latest && state.notifiedAt !== undefined && now - state.notifiedAt < DAY
  return { refresh, ...(latest && !shownToday ? { notice: { onPath: onPath.version, latest } } : {}) }
}

/**
 * After a command: print the notice when the global kit is behind, and start the daily npm lookup
 * in the background. Silent in CI, without a terminal on stderr, and with `KIT_NO_UPDATE_CHECK`.
 */
export function notifyUpdate(running: string, warn: (msg: string, hint: string) => void): void {
  if (updateCheckOff() || !process.stderr.isTTY) return
  const now = Date.now()
  const { notice, refresh } = updateNotice({ running, onPath: pathKit(), state: readUpdateState(), now })
  if (notice) {
    writeUpdateState({ notified: notice.latest, notifiedAt: now })
    warn(`kit ${notice.latest} is out; the kit on PATH is ${notice.onPath}`, 'kit upgrade --global')
  }
  if (refresh) {
    // Stamp first: a run that starts before the child answers does not spawn a second one.
    writeUpdateState({ checkedAt: now })
    refreshInBackground()
  }
}
