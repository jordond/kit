import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CATALOG_REF,
  catalogRefs,
  inRangeOutdated,
  manifestPaths,
  nextRange,
  type OpenManifest,
  type PackageManifest,
  planEdits,
  restoreCatalogRefs,
  setCatalogRange,
  setDeclaredRange,
} from '../../src/commands/deps'

// Ported from brewd lib/manifests.test.ts and commands/deps.test.ts.

const root = (): PackageManifest => ({
  workspaces: { catalog: { wrangler: '^4.107.0', 'better-auth': '1.6.27' } },
  devDependencies: { wrangler: CATALOG_REF, typescript: '^6.0.3' },
})

describe('catalogRefs', () => {
  test('finds the names pinned to the catalog, by field', () => {
    expect(catalogRefs(root())).toEqual([{ field: 'devDependencies', name: 'wrangler' }])
  })

  test('is empty for a manifest that pins nothing', () => {
    expect(catalogRefs({ dependencies: { hono: '^4.0.0' } })).toEqual([])
  })
})

describe('restoreCatalogRefs', () => {
  test('puts back a pin that an install unpinned', () => {
    const manifest = root()
    const pinned = catalogRefs(manifest)
    ;(manifest.devDependencies as Record<string, string>).wrangler = '^4.123.0'
    expect(restoreCatalogRefs(manifest, pinned)).toEqual(['wrangler'])
    expect(manifest.devDependencies?.wrangler).toBe(CATALOG_REF)
  })

  test('leaves a literal that was never pinned alone', () => {
    const manifest = root()
    expect(restoreCatalogRefs(manifest, catalogRefs(manifest))).toEqual([])
    expect(manifest.devDependencies?.typescript).toBe('^6.0.3')
  })

  test('ignores a pin whose dependency has since been dropped', () => {
    const manifest: PackageManifest = { devDependencies: {} }
    expect(restoreCatalogRefs(manifest, [{ field: 'devDependencies', name: 'wrangler' }])).toEqual([])
    expect(manifest.devDependencies).toEqual({})
  })
})

describe('nextRange', () => {
  test('keeps how the current range was spelled', () => {
    expect(nextRange('^4.107.0', '4.123.0')).toBe('^4.123.0')
    expect(nextRange('~4.107.0', '4.123.0')).toBe('~4.123.0')
    expect(nextRange('1.6.27', '1.6.30')).toBe('1.6.30')
  })

  test('carets anything it cannot read', () => {
    expect(nextRange('>=4.0.0', '4.123.0')).toBe('^4.123.0')
  })
})

describe('setCatalogRange', () => {
  test('rewrites the catalog entry and reports the move', () => {
    const manifest = root()
    expect(setCatalogRange(manifest, 'wrangler', '4.123.0')).toEqual({
      field: 'catalog',
      from: '^4.107.0',
      to: '^4.123.0',
    })
    const ws = manifest.workspaces as { catalog: Record<string, string> }
    expect(ws.catalog.wrangler).toBe('^4.123.0')
  })

  test('keeps an exact pin exact', () => {
    const manifest = root()
    setCatalogRange(manifest, 'better-auth', '1.6.30')
    expect((manifest.workspaces as { catalog: Record<string, string> }).catalog['better-auth']).toBe('1.6.30')
  })

  test('reads a top-level catalog too', () => {
    const manifest: PackageManifest = { workspaces: ['apps/*'], catalog: { zod: '^4.0.0' } }
    expect(setCatalogRange(manifest, 'zod', '4.5.0')?.to).toBe('^4.5.0')
    expect(manifest.catalog?.zod).toBe('^4.5.0')
  })

  test('is undefined for a package the catalog does not carry', () => {
    expect(setCatalogRange(root(), 'astro', '7.2.2')).toBeUndefined()
  })
})

describe('setDeclaredRange', () => {
  test('rewrites every field that declares a literal', () => {
    const manifest: PackageManifest = {
      dependencies: { react: '^19.2.7' },
      peerDependencies: { react: '^19.0.0' },
    }
    expect(setDeclaredRange(manifest, 'react', '19.3.0')).toEqual([
      { field: 'dependencies', from: '^19.2.7', to: '^19.3.0' },
      { field: 'peerDependencies', from: '^19.0.0', to: '^19.3.0' },
    ])
  })

  test('never overwrites a catalog or workspace reference', () => {
    const manifest: PackageManifest = {
      dependencies: { wrangler: CATALOG_REF, '@app/shared': 'workspace:*' },
    }
    expect(setDeclaredRange(manifest, 'wrangler', '4.123.0')).toEqual([])
    expect(setDeclaredRange(manifest, '@app/shared', '1.0.0')).toEqual([])
    expect(manifest.dependencies).toEqual({ wrangler: CATALOG_REF, '@app/shared': 'workspace:*' })
  })
})

const workspace = (): OpenManifest[] => [
  {
    path: 'package.json',
    manifest: {
      workspaces: { catalog: { hono: '^4.12.25', zod: '^4.4.3' } },
      devDependencies: { typescript: CATALOG_REF },
    } satisfies PackageManifest,
  },
  { path: 'apps/api/package.json', manifest: { dependencies: { hono: CATALOG_REF, aws4fetch: '1.0.20' } } },
]

describe('planEdits', () => {
  test('reports the catalog entry it moved', () => {
    expect(planEdits(workspace(), 'hono', '4.13.2')).toEqual([
      { path: 'package.json', name: 'hono', change: { field: 'catalog', from: '^4.12.25', to: '^4.13.2' } },
    ])
  })

  test('falls through to the package that declares its own version', () => {
    expect(planEdits(workspace(), 'aws4fetch', '1.0.21')).toEqual([
      {
        path: 'apps/api/package.json',
        name: 'aws4fetch',
        change: { field: 'dependencies', from: '1.0.20', to: '1.0.21' },
      },
    ])
  })

  test('plans nothing for a package the workspace does not declare', () => {
    expect(planEdits(workspace(), 'astro', '7.2.2')).toEqual([])
  })

  test('accumulates two packages that share a manifest', () => {
    const files = workspace()
    planEdits(files, 'hono', '4.13.2')
    planEdits(files, 'zod', '4.5.0')
    expect((files[0]!.manifest.workspaces as { catalog: unknown }).catalog).toEqual({
      hono: '^4.13.2',
      zod: '^4.5.0',
    })
  })
})

const OUTDATED_TABLE = `bun outdated v1.3.14 (0d9b296a)
|-----------------------------------------------------------|
| Package            | Current  | Update   | Latest  | Workspace            |
|-----------------------------------------------------------|
| hono               | 4.12.31  | 4.13.2   | 4.13.2  | catalog (@app/api)   |
|-----------------------------------------------------------|
| typescript (dev)   | 6.0.3    | 6.0.3    | 7.0.2   | catalog (app)        |
|-----------------------------------------------------------|
| wrangler (dev)     | 4.114.0  | 4.123.0  | 4.123.0 | catalog (@app/api)   |
|-----------------------------------------------------------|
| hono               | 4.12.31  | 4.13.2   | 4.13.2  | @app/admin           |
|-----------------------------------------------------------|`

describe('inRangeOutdated', () => {
  test('names only the rows whose range already allows the newer version', () => {
    expect(inRangeOutdated(OUTDATED_TABLE)).toEqual(['hono', 'wrangler'])
  })

  test('finds nothing in a table of out-of-range-only rows', () => {
    const table = OUTDATED_TABLE.split('\n')
      .filter((row) => !row.includes('hono') && !row.includes('wrangler'))
      .join('\n')
    expect(inRangeOutdated(table)).toEqual([])
  })
})

describe('manifestPaths', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-deps-'))
    for (const d of ['apps/api', 'apps/web', 'packages/shared', 'tools/x']) {
      mkdirSync(join(dir, d), { recursive: true })
      writeFileSync(join(dir, d, 'package.json'), '{}')
    }
    mkdirSync(join(dir, 'apps/empty'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('root plus every workspace member that has a manifest', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }))
    expect(manifestPaths(dir).map((p) => p.slice(dir.length + 1))).toEqual([
      'package.json',
      'apps/api/package.json',
      'apps/web/package.json',
      'packages/shared/package.json',
    ])
  })

  test('reads workspaces.packages', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: { packages: ['tools/*'] } }))
    expect(manifestPaths(dir).map((p) => p.slice(dir.length + 1))).toEqual([
      'package.json',
      'tools/x/package.json',
    ])
  })
})
