import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { KitConfig } from '../config/schema'
import { selectTargets, WORKSPACE } from './targets'

/**
 * `kit clean`: plan which build output to delete, then delete it. Planning only reads; nothing
 * outside the repo root is ever planned (bar the configured project's Xcode DerivedData), and no
 * symlink is followed or removed.
 */

export interface CleanItem {
  /** Absolute path. */
  path: string
  /** What the user sees: repo-relative, or absolute for DerivedData. */
  label: string
  bytes: number
  /** Target name, `workspace`, or `ios`. */
  owner: string
  /** Planned only with `--deep`. */
  deep?: boolean
  /** Why this one deserves a second look (`local D1/KV data`). */
  note?: string
  /** Xcode DerivedData: the one path allowed outside the repo root. */
  external?: boolean
}

export interface Refusal {
  path: string
  reason: string
}

export interface CleanPlan {
  items: CleanItem[]
  refused: Refusal[]
}

export interface CleanOptions {
  /** Target names from argv; empty means everything. */
  targets?: string[]
  deep?: boolean
  /** Home directory holding `Library/Developer/Xcode/DerivedData`; default the user's. */
  home?: string
  /** `KIT_OUTPUT_DIR`: where `kit release ios` keeps `release.ios.output`; default the repo root. */
  outputDir?: string
}

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Why `path` must not be deleted, or undefined when it is safe: it has to sit strictly inside the
 * repo root, by name and after resolving symlinks in its parents, and must not be a symlink itself.
 */
export function refusal(root: string, path: string): string | undefined {
  const abs = resolve(root, path)
  if (!inside(resolve(root), abs)) return 'outside the repo root'
  if (lstatSync(abs).isSymbolicLink()) return 'a symlink'
  const real = join(realpathSync(dirname(abs)), basename(abs))
  if (!inside(realpathSync(root), real)) return 'resolves outside the repo root through a symlink'
  return undefined
}

/** Bytes under `path`, counting a symlink as itself (never what it points at). */
export function sizeOf(path: string): number {
  try {
    const st = lstatSync(path)
    if (!st.isDirectory()) return st.size
    return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0)
  } catch {
    return 0
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/**
 * `build/` dirs of the Gradle projects under `dir`: only next to a build or settings script, so a
 * source package that happens to be called `build` is left alone. Symlinked dirs are not entered.
 */
export function gradleBuildDirs(dir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  const project = entries.some((e) => /^(build|settings)\.gradle(\.kts)?$/.test(e.name))
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'build') {
      if (project) out.push(join(dir, e.name))
    } else if (e.name !== 'node_modules' && e.name !== 'src' && !e.name.startsWith('.')) {
      gradleBuildDirs(join(dir, e.name), out)
    }
  }
  return out
}

/** DerivedData dirs Xcode made for `project` (absolute): `<Name>-<hash>` whose info.plist names that project. */
export function derivedDataDirs(project: string, home = homedir()): string[] {
  const dir = join(home, 'Library/Developer/Xcode/DerivedData')
  const prefix = `${basename(project, extname(project))}-`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const same = (a: string, b: string) => {
    if (resolve(a) === resolve(b)) return true
    try {
      return realpathSync(a) === realpathSync(b)
    } catch {
      return false
    }
  }
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => join(dir, n))
    .filter((d) => {
      try {
        if (!lstatSync(d).isDirectory()) return false
        const plist = readFileSync(join(d, 'info.plist'), 'utf8')
        const workspace = /<key>WorkspacePath<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1]
        return !!workspace && same(workspace, project)
      } catch {
        return false
      }
    })
}

interface Candidate {
  path: string
  owner: string
  deep?: boolean
  note?: string
  external?: boolean
}

/** JS target dirs: bundler output and framework caches. */
const JS_OUTPUT = [
  'dist',
  '.wrangler/tmp',
  '.astro',
  'node_modules/.vite',
  'node_modules/.astro',
  'node_modules/.cache',
]

/**
 * What `kit clean` would delete. Per kind: gradle → `.gradle/`, `.kotlin/` and every project's
 * `build/` under the Gradle root; kotlin → `build/` in the toolchain root; worker, vite, astro →
 * `dist/`, `.wrangler/tmp`, `.astro` and the caches in `node_modules`; with `release.ios`, the
 * release output. `deep` adds `node_modules` (root and `.kit/`), `.wrangler/state` and DerivedData.
 */
export function planClean(root: string, config: KitConfig, opts: CleanOptions = {}): CleanPlan {
  const names = opts.targets ?? []
  const sel = selectTargets(config, names)
  const everything = !names.length
  const refused: Refusal[] = []
  const candidates: Candidate[] = []
  const add = (owner: string, base: string, paths: string[], more: Partial<Candidate> = {}) => {
    for (const p of paths) candidates.push({ path: resolve(base, p), owner, ...more })
  }
  /** A config dir that may be walked: the repo root or inside it. */
  const within = (dir: string): boolean => {
    const abs = resolve(root, dir)
    if (abs === resolve(root)) return true
    if (!exists(abs)) return false
    const reason = refusal(root, abs)
    if (reason) refused.push({ path: abs, reason })
    return !reason
  }

  for (const [name, t] of sel.targets) {
    if (t.kind === 'gradle') {
      const dir = resolve(root, config.gradle?.root ?? t.dir)
      if (within(dir)) add(name, dir, ['.gradle', '.kotlin', ...gradleBuildDirs(dir)])
    } else if (t.kind === 'kotlin') {
      const dir = resolve(root, config.toolchain?.root ?? t.dir)
      if (within(dir)) add(name, dir, ['build'])
    } else if (t.kind === 'worker' || t.kind === 'vite' || t.kind === 'astro') {
      const dir = resolve(root, t.dir)
      if (!within(dir)) continue
      add(name, dir, JS_OUTPUT)
      if (opts.deep) add(name, dir, ['.wrangler/state'], { deep: true, note: 'local D1/KV data' })
    }
  }

  const ios = config.release?.ios
  if (ios && (everything || sel.targets.some(([, t]) => t.kind === 'gradle' || t.kind === 'kotlin'))) {
    const base = resolve(root, opts.outputDir ?? '.')
    const artifact = resolve(base, ios.output)
    const dir = dirname(artifact)
    // The dir the .ipa lands in, unless that dir also holds sources: then only the artifact.
    const sources = [
      ...Object.values(config.targets).map((t) => t.dir),
      ...(config.gradle ? [config.gradle.root] : []),
      ...(config.toolchain ? [config.toolchain.root] : []),
      ios.project,
    ].map((p) => resolve(root, p))
    const shared = dir === base || sources.some((s) => s === dir || inside(dir, s))
    add('ios', root, [shared ? artifact : dir])
    if (opts.deep) {
      add('ios', root, derivedDataDirs(resolve(root, ios.project), opts.home), { deep: true, external: true })
    }
  }

  if (opts.deep && (everything || names.includes(WORKSPACE))) {
    add(WORKSPACE, root, ['node_modules', '.kit/node_modules'], { deep: true })
  }

  const seen = new Set<string>()
  const kept: Candidate[] = []
  for (const c of candidates) {
    if (seen.has(c.path) || !exists(c.path)) continue
    seen.add(c.path)
    const reason = c.external
      ? lstatSync(c.path).isSymbolicLink()
        ? 'a symlink'
        : undefined
      : refusal(root, c.path)
    if (reason) refused.push({ path: c.path, reason })
    else kept.push(c)
  }
  // A path under another planned path goes with it; listing both would count its bytes twice.
  const items = kept
    .filter((c) => !kept.some((o) => o !== c && inside(o.path, c.path)))
    .map((c) => ({
      ...c,
      label: c.external ? c.path : relative(root, c.path),
      bytes: sizeOf(c.path),
    }))
  return { items, refused }
}

export interface Removal {
  removed: CleanItem[]
  failed: { item: CleanItem; error: string }[]
}

/** Delete the planned items. Each is checked again first: a path that became unsafe since planning fails. */
export function removeItems(root: string, items: CleanItem[]): Removal {
  const out: Removal = { removed: [], failed: [] }
  for (const item of items) {
    try {
      if (!exists(item.path)) continue
      const reason = item.external ? undefined : refusal(root, item.path)
      if (reason || lstatSync(item.path).isSymbolicLink()) throw new Error(reason ?? 'a symlink')
      rmSync(item.path, { recursive: true, force: true })
      out.removed.push(item)
    } catch (e) {
      out.failed.push({ item, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
