import { Database } from 'bun:sqlite'
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { onCleanup } from '../cleanup'
import type { Platform } from '../devices'
import { ExitCode, KitError } from '../errors'
import { runToStderr } from '../proc'
import { destOf, entriesFor, type FixtureConfig, type FixtureEntry } from './config'

/** The local half of both directions: staging a fixture for a load, assembling one from a dump. */

export interface Staged {
  dir: string
  dispose: () => void
}

/** Whether the staged / captured tree holds `entry` as the right kind of thing. */
export function hasEntry(dir: string, entry: FixtureEntry): boolean {
  const path = join(dir, entry.from)
  if (!existsSync(path)) return false
  return statSync(path).isDirectory() === entry.isDir
}

const notLink = (src: string): boolean => !lstatSync(src).isSymbolicLink()

/** A temp copy of the fixture that is removed after, and on Ctrl-C. */
export function stageFixture(source: string): Staged {
  const dir = mkdtempSync(join(tmpdir(), 'kit-fixture-'))
  const dispose = () => rmSync(dir, { recursive: true, force: true })
  const off = onCleanup(dispose)
  try {
    // The fixture dir itself may be a link (`latest -> v2`); links inside it never travel.
    cpSync(realpathSync(source), dir, { recursive: true, filter: notLink })
  } catch (e) {
    dispose()
    off()
    throw e
  }
  return {
    dir,
    dispose: () => {
      dispose()
      off()
    },
  }
}

/** Run `fixtures.prepare` on the staged copy: the app rebases dates (or anything else) with its own code. */
export async function runPrepare(
  cfg: FixtureConfig,
  staged: string,
  ctx: { name: string; platform: Platform; root: string },
): Promise<void> {
  if (cfg.prepare === undefined) return
  const label = cfg.prepareLabel ?? cfg.prepare
  try {
    accessSync(cfg.prepare, constants.X_OK)
  } catch {
    throw new KitError(
      `fixtures.prepare ${label} is not an executable file`,
      `chmod +x ${label}`,
      ExitCode.config,
    )
  }
  const code = await runToStderr([cfg.prepare], {
    cwd: staged,
    env: {
      KIT_FIXTURE: ctx.name,
      KIT_FIXTURE_DIR: staged,
      KIT_PLATFORM: ctx.platform,
      KIT_ROOT: ctx.root,
    },
  })
  if (code !== 0)
    throw new KitError(`fixtures.prepare ${label} exited with ${code}`, 'The fixture was not loaded')
}

// ---- dump -------------------------------------------------------------------------------------

/** Fold a database's WAL into the file and drop the sidecars, with no sqlite3 binary. */
export function checkpointDatabase(path: string): void {
  const wal = `${path}-wal`
  if (existsSync(wal)) {
    try {
      const db = new Database(path)
      try {
        db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally {
        db.close()
      }
    } catch (e) {
      throw new KitError(`Could not checkpoint ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  rmSync(wal, { force: true })
  rmSync(`${path}-shm`, { force: true })
}

/** Files 0644, dirs 0755: a phone's own modes would show up in git as changes. */
export function normalizeModes(dir: string): void {
  chmodSync(dir, 0o755)
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) normalizeModes(path)
    else if (stat.isFile()) chmodSync(path, 0o644)
  }
}

/**
 * Copy what the config names from `srcRoot` (the data container, or a tar extracted from the app's
 * data dir: both have the app's own layout) into `out` in fixture layout. Returns the `from` paths found.
 */
export function assembleCapture(
  srcRoot: string,
  cfg: FixtureConfig,
  platform: Platform,
  out: string,
): string[] {
  const found: string[] = []
  for (const entry of entriesFor(cfg, platform)) {
    const src = join(srcRoot, destOf(entry, platform))
    if (!existsSync(src) || lstatSync(src).isSymbolicLink() || statSync(src).isDirectory() !== entry.isDir) {
      continue
    }
    const dest = join(out, entry.from)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true, filter: notLink })
    if (entry.sqlite && !entry.isDir) {
      for (const ext of ['-wal', '-shm']) {
        if (existsSync(src + ext)) cpSync(src + ext, dest + ext)
      }
      checkpointDatabase(dest)
    }
    found.push(entry.from)
  }
  return found
}

/**
 * Put a complete capture in place of `<fixtures.dir>/<name>`. `fresh` was built next to it, so the
 * swap is a rename; the old fixture is only deleted once the new one is in place.
 */
export function swapIn(fresh: string, target: string): void {
  const old = `${fresh}.old`
  if (existsSync(target)) renameSync(target, old)
  try {
    renameSync(fresh, target)
  } catch (e) {
    if (existsSync(old)) renameSync(old, target)
    throw e
  }
  rmSync(old, { recursive: true, force: true })
}

/**
 * Capture `srcRoot` (see `assembleCapture`) as `<fixtures.dir>/<name>`. The first entry that has
 * a destination on `platform` must come back, or nothing is replaced. Entries with no destination
 * here are carried over from the fixture being replaced, so a dump from one platform keeps the other's files.
 */
export function commitCapture(
  cfg: FixtureConfig,
  platform: Platform,
  name: string,
  srcRoot: string,
): string[] {
  const entries = entriesFor(cfg, platform)
  const required = entries[0]
  if (required === undefined) {
    throw new KitError(`No fixtures.files entry has a ${platform} destination`, undefined, ExitCode.config)
  }
  const target = join(cfg.dir, name)
  mkdirSync(cfg.dir, { recursive: true })
  const fresh = mkdtempSync(join(cfg.dir, `.${name}-`))
  const off = onCleanup(() => rmSync(fresh, { recursive: true, force: true }))
  try {
    const found = assembleCapture(srcRoot, cfg, platform, fresh)
    if (!found.includes(required.from)) {
      throw new KitError(
        `${destOf(required, platform)} is not on the device; nothing was replaced`,
        'Launch the app once first',
        ExitCode.precondition,
      )
    }
    for (const entry of cfg.files.filter((f) => f[platform] === undefined)) {
      const old = join(target, entry.from)
      if (!existsSync(old)) continue
      mkdirSync(dirname(join(fresh, entry.from)), { recursive: true })
      cpSync(old, join(fresh, entry.from), { recursive: true })
    }
    normalizeModes(fresh)
    swapIn(fresh, target)
    return found.map((f) => `${cfg.dirLabel}/${name}/${f}`)
  } finally {
    rmSync(fresh, { recursive: true, force: true })
    off()
  }
}
