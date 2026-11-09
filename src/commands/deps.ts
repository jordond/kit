import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineCommand, type KitContext } from '../cli/command'

/**
 * `kit deps [update|latest]`, ported from brewd `cli deps` (+ `lib/manifests.ts`). What is out of
 * date across the bun workspace, and the two ways to move: `update` stays inside the declared
 * ranges (bun.lock only), `latest` rewrites the ranges themselves, the catalog entry first.
 * Both defend the root manifest's `catalog:` references, which `bun update` unpins.
 */

// ── manifests ────────────────────────────────────────────────────────────────

export const CATALOG_REF = 'catalog:'
export const CATALOG_FIELD = 'catalog'

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number]

type DependencyMap = Record<string, string>

export interface PackageManifest {
  workspaces?: string[] | { packages?: string[]; catalog?: DependencyMap }
  catalog?: DependencyMap
  dependencies?: DependencyMap
  devDependencies?: DependencyMap
  peerDependencies?: DependencyMap
  optionalDependencies?: DependencyMap
  [key: string]: unknown
}

export interface CatalogRef {
  readonly field: DependencyField
  readonly name: string
}

export interface RangeChange {
  readonly field: DependencyField | typeof CATALOG_FIELD
  readonly from: string
  readonly to: string
}

export function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

export function writeManifest(path: string, manifest: PackageManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** The workspace catalog: `workspaces.catalog`, or a top-level `catalog` (both are bun's). */
export function catalogOf(manifest: PackageManifest): DependencyMap | undefined {
  const ws = manifest.workspaces
  return (ws && !Array.isArray(ws) ? ws.catalog : undefined) ?? manifest.catalog
}

/** Member globs from `workspaces` (array or `{ packages }`). */
export function workspaceGlobs(manifest: PackageManifest): string[] {
  const ws = manifest.workspaces
  if (!ws) return []
  return Array.isArray(ws) ? ws : (ws.packages ?? [])
}

export function catalogRefs(manifest: PackageManifest): CatalogRef[] {
  const refs: CatalogRef[] = []
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (range === CATALOG_REF) refs.push({ field, name })
    }
  }
  return refs
}

/**
 * Bun's `bun update` rewrites the **root** manifest's `catalog:` pins into the literal version it
 * just resolved (workspace members keep theirs). Put back the pins that were there before.
 */
export function restoreCatalogRefs(manifest: PackageManifest, refs: readonly CatalogRef[]): string[] {
  const restored: string[] = []
  for (const { field, name } of refs) {
    const declared = manifest[field]
    if (declared === undefined || declared[name] === undefined || declared[name] === CATALOG_REF) continue
    declared[name] = CATALOG_REF
    restored.push(name)
  }
  return restored
}

/** The range for a bumped dependency, spelled like the current one: caret stays caret, exact stays exact. */
export function nextRange(current: string, latest: string): string {
  if (current.startsWith('~')) return `~${latest}`
  if (/^\d/.test(current)) return latest
  return `^${latest}`
}

export function setCatalogRange(
  manifest: PackageManifest,
  name: string,
  latest: string,
): RangeChange | undefined {
  const catalog = catalogOf(manifest)
  const current = catalog?.[name]
  if (catalog === undefined || current === undefined) return undefined
  const to = nextRange(current, latest)
  catalog[name] = to
  return { field: CATALOG_FIELD, from: current, to }
}

/** Every field of one manifest that names `name` with a literal range. `catalog:` and `workspace:` are references. */
export function setDeclaredRange(manifest: PackageManifest, name: string, latest: string): RangeChange[] {
  const changes: RangeChange[] = []
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest[field]
    const current = declared?.[name]
    if (declared === undefined || current === undefined) continue
    if (current === CATALOG_REF || current.startsWith('workspace:')) continue
    const to = nextRange(current, latest)
    declared[name] = to
    changes.push({ field, from: current, to })
  }
  return changes
}

/** The root manifest and each workspace member's, as absolute paths. */
export function manifestPaths(root: string): string[] {
  const rootManifest = join(root, 'package.json')
  if (!existsSync(rootManifest)) return []
  const paths = [rootManifest]
  for (const pattern of workspaceGlobs(readManifest(rootManifest))) {
    const glob = new Bun.Glob(`${pattern.replace(/\/$/, '')}/package.json`)
    for (const file of [...glob.scanSync({ cwd: root, onlyFiles: true })].sort()) {
      if (!file.includes('node_modules')) paths.push(join(root, file))
    }
  }
  return paths
}

// ── command ──────────────────────────────────────────────────────────────────

const OUTDATED_CMD = ['bun', 'outdated', '--filter', '*']

/**
 * Packages `bun outdated` lists with a newer version their declared range already allows. `(dev)`
 * is the table's annotation, not part of the name.
 */
export function inRangeOutdated(table: string): string[] {
  const names = new Set<string>()
  for (const row of table.split('\n')) {
    const [, name, current, update] = row.split('|').map((cell) => cell.trim())
    if (name === undefined || update === undefined || name === 'Package') continue
    if (current === update) continue
    names.add(name.replace(/ \(dev\)$/, ''))
  }
  return [...names]
}

export interface OpenManifest {
  readonly path: string
  readonly manifest: PackageManifest
}

export interface PlannedEdit {
  readonly path: string
  readonly name: string
  readonly change: RangeChange
}

/** Bump `name` to `latest` wherever the workspace declares its version. Edits in place, so two
 *  packages that share one file (the catalog) both survive the write. */
export function planEdits(files: readonly OpenManifest[], name: string, latest: string): PlannedEdit[] {
  return files.flatMap(({ path, manifest }) => {
    const inCatalog = setCatalogRange(manifest, name, latest)
    const changes = [
      ...(inCatalog === undefined ? [] : [inCatalog]),
      ...setDeclaredRange(manifest, name, latest),
    ]
    return changes.map((change) => ({ path, name, change }))
  })
}

async function latestVersion(name: string): Promise<string> {
  const registry = (process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/$/, '')
  const res = await fetch(`${registry}/${name.replace('/', '%2f')}/latest`)
  if (!res.ok) throw new Error(`Registry lookup failed for ${name}: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { version?: unknown }
  if (typeof body.version !== 'string') throw new Error(`Registry returned no version for ${name}`)
  return body.version
}

export default defineCommand({
  description: 'List or update npm dependencies across the workspace (catalog-aware)',
  group: 'Setup',
  examples: [
    'kit deps                     # list everything with a newer version',
    'kit deps update              # newest versions the declared ranges allow (bun.lock only)',
    'kit deps latest wrangler     # rewrite ranges to latest (catalog entry first), then install',
  ].join('\n'),
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { detectPackageManager } = await import('../lib/pm')
    const { root } = requireProject(ctx)
    if (detectPackageManager(root, root) !== 'bun') {
      throw new KitError('kit deps supports bun workspaces only', undefined, ExitCode.usage)
    }
    const [sub, ...names] = ctx.positionals
    switch (sub) {
      case undefined:
        return await list(ctx, root)
      case 'update':
        if (names.length) {
          throw new KitError(
            'kit deps update takes no package names',
            'To move a range, use `kit deps latest <pkgs…>`',
            ExitCode.usage,
          )
        }
        return await update(ctx, root)
      case 'latest':
        if (!names.length) {
          throw new KitError(
            'kit deps latest needs package names',
            'e.g. `kit deps latest wrangler astro`',
            ExitCode.usage,
          )
        }
        return await latest(ctx, root, names)
      default:
        throw new KitError(
          `Unknown deps command "${sub}"`,
          'Use `kit deps`, `update` or `latest`',
          ExitCode.usage,
        )
    }
  },
})

async function list(ctx: KitContext, root: string): Promise<void> {
  const { run } = await import('../lib/proc')
  if (ctx.flags.dryRun) {
    ctx.log.step(OUTDATED_CMD.join(' '))
    return
  }
  process.exitCode = await run(OUTDATED_CMD, { cwd: root })
}

/**
 * bun.lock and nothing else: naming packages on `bun update` also writes them into the root
 * manifest, so every manifest goes back byte-for-byte and only the lockfile survives. A plain
 * install then re-settles the lockfile against the restored manifests.
 */
async function update(ctx: KitContext, root: string): Promise<void> {
  const { run, runCapture } = await import('../lib/proc')
  const listed = await runCapture(OUTDATED_CMD, { cwd: root })
  if (listed.code !== 0) {
    process.exitCode = listed.code
    return
  }
  const names = inRangeOutdated(listed.stdout)
  if (!names.length) {
    ctx.log.success('Every declared range already has its newest match installed')
    return
  }
  ctx.log.dim(`in range: ${names.join(', ')}`)
  // Two passes: named packages are the only way to move a member's dependency, yet bun won't move
  // a catalog-backed dependency of the root when named; only the argless form re-resolves those.
  const cmds = [
    ['bun', 'update'],
    ['bun', 'update', ...names],
    ['bun', 'install'],
  ]
  if (ctx.flags.dryRun) {
    for (const c of cmds) ctx.log.step(c.join(' '))
    return
  }
  const before = manifestPaths(root).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  let code = 0
  for (const cmd of cmds.slice(0, 2)) {
    code = await run(cmd, { cwd: root })
    if (code !== 0) break
  }
  for (const { path, text } of before) writeFileSync(path, text)
  if (code === 0) code = await run(cmds[2]!, { cwd: root })
  if (code !== 0) process.exitCode = code
}

async function latest(ctx: KitContext, root: string, names: string[]): Promise<void> {
  const pc = (await import('picocolors')).default
  const { ExitCode, KitError } = await import('../lib/errors')
  const { emitJson } = await import('../lib/log')
  const { run } = await import('../lib/proc')
  const rootManifest = join(root, 'package.json')
  const files = manifestPaths(root).map((path) => ({ path, manifest: readManifest(path) }))
  const pinned = catalogRefs(readManifest(rootManifest))
  const planned = await Promise.all(
    names.map(async (name) => ({ name, edits: planEdits(files, name, await latestVersion(name)) })),
  )
  const undeclared = planned.filter((p) => !p.edits.length).map((p) => p.name)
  if (undeclared.length) {
    throw new KitError(
      `Not a dependency of this workspace: ${undeclared.join(', ')}`,
      undefined,
      ExitCode.usage,
    )
  }
  const edits = planned.flatMap((p) => p.edits)
  if (ctx.flags.json) {
    emitJson({
      dryRun: ctx.flags.dryRun,
      edits: edits.map((e) => ({ ...e, path: relative(root, e.path) || 'package.json' })),
    })
  } else {
    for (const { path, name, change } of edits) {
      const where = change.field === CATALOG_FIELD ? 'catalog' : `${relative(root, path)} ${change.field}`
      ctx.log.info(`  ${pc.bold(name)}  ${change.from} → ${pc.green(change.to)}  ${pc.dim(where)}`)
    }
  }
  if (ctx.flags.dryRun) return
  const touched = new Set(edits.map((e) => e.path))
  for (const { path, manifest } of files) if (touched.has(path)) writeManifest(path, manifest)

  const code = await run(['bun', 'install'], { cwd: root })
  const manifest = readManifest(rootManifest)
  const restored = restoreCatalogRefs(manifest, pinned)
  if (restored.length) {
    writeManifest(rootManifest, manifest)
    ctx.log.dim(`re-pinned to the catalog: ${restored.join(', ')}`)
  }
  if (code !== 0) process.exitCode = code
}
