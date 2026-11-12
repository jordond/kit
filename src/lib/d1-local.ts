import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { KitConfig } from '../config/schema'
import type { D1Database } from './cloudflare'
import { ExitCode, KitError } from './errors'
import {
  localD1Files,
  localD1Id,
  localD1Ids,
  localD1Sqlite,
  localD1StateDir,
  readWranglerConfig,
} from './worker'

/**
 * One database's local state, for the commands that delete it (`kit db reset`, a local
 * `kit db restore`). kit works out the file name the way miniflare does; every check here exists so
 * that a changed wrangler layout stops the command instead of letting it report a reset that
 * deleted nothing.
 */
export interface LocalD1 {
  /** The worker target's directory. */
  dir: string
  /** The main SQLite file, whether or not it exists yet. */
  file: string
  /** The files that exist now (the main file and its WAL sidecars). */
  files: string[]
}

const unrecognised = (what: string, where: string): KitError =>
  new KitError(
    `Local D1 layout not recognised: ${what}`,
    `Run \`kit clean --deep\` or remove ${where}/.wrangler/state by hand`,
  )

/**
 * Find a database's local files. Exit 3 when the wrangler config has no entry for it; exit 1 when
 * wrangler's state is laid out differently from what kit knows: a version dir other than `v3`, or
 * SQLite files none of which belongs to a database this worker binds. A file of another bound
 * database proves the layout, so this one is just fresh, as with no SQLite at all.
 */
export function locateLocalD1(root: string, config: KitConfig, db: D1Database): LocalD1 {
  const dir = resolve(root, config.targets[db.target]!.dir)
  const rel = (p: string) => relative(root, p) || '.'
  const wranglerConfig = readWranglerConfig(dir)
  const id = wranglerConfig && localD1Id(wranglerConfig.data, db.name)
  if (!wranglerConfig || !id) {
    const where = wranglerConfig ? rel(wranglerConfig.file) : `${rel(dir)}/wrangler.jsonc`
    throw new KitError(
      `No d1_databases entry for ${db.name} in ${where}`,
      'kit finds the local database file through its database_id or binding',
      ExitCode.config,
    )
  }
  const state = join(dir, '.wrangler/state')
  const versions = existsSync(state) ? readdirSync(state).filter((n) => /^v\d+$/.test(n) && n !== 'v3') : []
  if (versions.length) {
    throw unrecognised(
      `${rel(state)} holds ${versions.join(', ')}, kit knows v3. Nothing was deleted`,
      rel(dir),
    )
  }
  const all = localD1Files(dir, id)
  // Every cloudflare.d1 entry of this target resolves through the same d1_databases list.
  const known = new Set(localD1Ids(wranglerConfig.data).map((k) => localD1Files(dir, k)[0]!))
  const present = localD1Sqlite(dir)
  if (present.length && !present.some((f) => known.has(f))) {
    throw unrecognised(
      `${rel(localD1StateDir(dir))} holds databases, none of them one this worker binds. Nothing was deleted`,
      rel(dir),
    )
  }
  return { dir, file: all[0]!, files: all.filter((f) => existsSync(f)) }
}

export function removeLocalD1(local: LocalD1): void {
  for (const f of local.files) rmSync(f, { force: true })
}

/**
 * After wrangler has written the database again: it must be where kit looked. If it is not, wrangler
 * keeps local state somewhere else, and the old data was never deleted.
 */
export function requireLocalD1(root: string, db: D1Database, local: LocalD1): void {
  if (existsSync(local.file)) return
  const rel = (p: string) => relative(root, p) || '.'
  throw unrecognised(
    `wrangler did not write ${db.name} to ${rel(local.file)}, so the old local data may still be in place`,
    rel(local.dir),
  )
}
