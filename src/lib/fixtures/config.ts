import { existsSync, readdirSync, statSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import type { KitConfig } from '../../config/schema'
import type { Platform } from '../devices'
import { ExitCode, KitError } from '../errors'

/**
 * The `fixtures` block, validated and normalised, and the pure plan of what a load removes and copies.
 * Every path the repo declares ends up inside a simulator container or an app's data dir, so a
 * path that is absolute or climbs out with `..` is a config error before anything is touched.
 */

export interface FixtureEntry {
  /** Path inside the fixture, no trailing slash. */
  from: string
  /** `from` is a directory (it ended in `/`). */
  isDir: boolean
  /** Destination dir per platform, relative to the container / data dir (`.` is the root). */
  ios?: string
  android?: string
  sqlite: boolean
}

export interface FixtureConfig {
  /** Absolute dir holding one sub-dir per fixture. */
  dir: string
  /** The dir as written, for messages. */
  dirLabel: string
  files: FixtureEntry[]
  clear: { ios: string[]; android: string[] }
  /** Absolute path of the prepare script. */
  prepare?: string
  prepareLabel?: string
}

const MINIMAL = `fixtures: { dir: 'fixtures', files: [{ from: 'app.db', ios: 'Documents/', android: 'databases/', sqlite: true }] }`

/** A relative path with no `..`, normalised without a trailing slash (`.` for the root). */
export function cleanRelPath(value: string, what: string): string {
  const bad = (why: string) =>
    new KitError(
      `fixtures: ${what} "${value}" ${why}`,
      'Use a path relative to the app data dir',
      ExitCode.config,
    )
  if (value.trim() === '') throw bad('is empty')
  if (value.includes('\0') || value.includes('\\')) throw bad('has an unsupported character')
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) throw bad('is absolute')
  if (value.split('/').includes('..')) throw bad('contains ..')
  return posix.normalize(value).replace(/\/+$/, '') || '.'
}

/** The `fixtures` block, or a config error with the smallest block that works. */
export function fixtureConfig(root: string, config: KitConfig): FixtureConfig {
  const block = config.fixtures
  if (block === undefined) {
    throw new KitError('kit.config.ts has no fixtures block', `Add ${MINIMAL}`, ExitCode.config)
  }
  const dirLabel = cleanRelPath(block.dir, 'dir')
  const files = block.files.map((f): FixtureEntry => {
    const from = cleanRelPath(f.from, 'from')
    if (from === '.') {
      throw new KitError('fixtures: from "." is the whole fixture', 'Name a file or a dir', ExitCode.config)
    }
    const isDir = f.from.endsWith('/')
    const entry: FixtureEntry = { from, isDir, sqlite: f.sqlite === true }
    for (const platform of ['ios', 'android'] as const) {
      const dest = f[platform]
      if (dest === undefined) continue
      const clean = cleanRelPath(dest, `${platform} destination`)
      if (isDir && clean === '.') {
        throw new KitError(
          `fixtures: ${platform} destination "${dest}" for dir "${f.from}" would replace the whole app data`,
          'Give the dir its own destination, like Documents/photos/',
          ExitCode.config,
        )
      }
      entry[platform] = clean
    }
    return entry
  })
  const clear = (platform: Platform): string[] =>
    (block.clear?.[platform] ?? []).map((p) => {
      const clean = cleanRelPath(p, `${platform} clear path`)
      if (clean === '.') {
        throw new KitError(
          `fixtures: ${platform} clear path "${p}" is the whole app data`,
          undefined,
          ExitCode.config,
        )
      }
      return clean
    })
  let prepare: string | undefined
  if (block.prepare !== undefined) prepare = resolve(root, cleanRelPath(block.prepare, 'prepare'))
  return {
    dir: resolve(root, dirLabel),
    dirLabel,
    files,
    clear: { ios: clear('ios'), android: clear('android') },
    prepare,
    prepareLabel: block.prepare,
  }
}

/** The entries that have a destination on `platform`; the others are skipped. */
export const entriesFor = (cfg: FixtureConfig, platform: Platform): FixtureEntry[] =>
  cfg.files.filter((f) => f[platform] !== undefined)

/** Where an entry lives inside the container / data dir: the file itself, or the dir. */
export function destOf(entry: FixtureEntry, platform: Platform): string {
  const dest = entry[platform]!
  return entry.isDir ? dest : posix.join(dest, posix.basename(entry.from))
}

// ---- fixture names ----------------------------------------------------------------------------

/** Fixture names on disk: every non-hidden sub-dir of `fixtures.dir`. */
export function listFixtures(cfg: FixtureConfig): string[] {
  if (!existsSync(cfg.dir)) return []
  return readdirSync(cfg.dir)
    .filter((n) => !n.startsWith('.') && statSync(resolve(cfg.dir, n)).isDirectory())
    .sort()
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function checkName(name: string): string {
  if (!NAME.test(name)) {
    throw new KitError(
      `"${name}" is not a fixture name`,
      'Use letters, digits, dots, dashes and underscores',
      ExitCode.usage,
    )
  }
  return name
}

/** `name`, or the only fixture when there is exactly one; else a usage error listing them. */
export function resolveFixtureName(cfg: FixtureConfig, name: string | undefined): string {
  if (name !== undefined) return checkName(name)
  const all = listFixtures(cfg)
  if (all.length === 1) return all[0]!
  throw new KitError(
    all.length === 0 ? `No fixtures in ${cfg.dirLabel}` : 'Several fixtures; name one',
    all.length === 0
      ? 'Capture one with `kit fixture dump <platform> <name>`'
      : `Available: ${all.join(', ')}`,
    ExitCode.usage,
  )
}

/** The fixture dir to load; a usage error listing what exists when it is missing. */
export function requireFixtureDir(cfg: FixtureConfig, name: string): string {
  const dir = resolve(cfg.dir, checkName(name))
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const all = listFixtures(cfg)
    throw new KitError(
      `No fixture "${name}" in ${cfg.dirLabel}`,
      all.length ? `Available: ${all.join(', ')}` : 'Capture one with `kit fixture dump <platform> <name>`',
      ExitCode.usage,
    )
  }
  return dir
}

// ---- the load plan ----------------------------------------------------------------------------

export type LoadOp =
  /** Delete a file or a dir (recursively); fine when it is absent. */
  | { op: 'remove'; path: string }
  /** Copy a staged file (to the file path) or a staged dir's contents (into the dir). */
  | { op: 'copy'; from: string; to: string; dir: boolean }

/**
 * What a load does inside the container / data dir, in order. Each destination is removed first,
 * so a file the fixture lacks never survives from an earlier load; `has` says what the fixture holds.
 */
export function loadOps(
  cfg: FixtureConfig,
  platform: Platform,
  has: (entry: FixtureEntry) => boolean,
): LoadOp[] {
  const ops: LoadOp[] = []
  for (const entry of entriesFor(cfg, platform)) {
    const to = destOf(entry, platform)
    ops.push({ op: 'remove', path: to })
    if (entry.sqlite) ops.push({ op: 'remove', path: `${to}-wal` }, { op: 'remove', path: `${to}-shm` })
    if (has(entry)) ops.push({ op: 'copy', from: entry.from, to, dir: entry.isDir })
  }
  for (const path of cfg.clear[platform]) ops.push({ op: 'remove', path })
  return ops
}

/** Human lines for a dry run. */
export function describeOps(ops: readonly LoadOp[]): string[] {
  return ops.map((o) =>
    o.op === 'remove' ? `remove ${o.path}` : `copy ${o.from}${o.dir ? '/' : ''} -> ${o.to}`,
  )
}

/** In-app paths a load writes. */
export const writtenPaths = (ops: readonly LoadOp[]): string[] =>
  ops.flatMap((o) => (o.op === 'copy' ? [o.dir ? `${o.to}/` : o.to] : []))

/** A dry-run dump: what is pulled from the app, and the repo-relative files it would write. */
export function dumpPlan(
  cfg: FixtureConfig,
  platform: Platform,
  name: string,
): { plan: string[]; files: string[] } {
  const entries = entriesFor(cfg, platform)
  const to = (e: FixtureEntry) => `${cfg.dirLabel}/${name}/${e.from}`
  return {
    plan: entries.map((e) => `pull ${destOf(e, platform)}${e.isDir ? '/' : ''} -> ${to(e)}`),
    files: entries.map(to),
  }
}
