import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configSchema, type KitConfigInput } from '../../src/config/schema'
import {
  derivedDataDirs,
  formatBytes,
  gradleBuildDirs,
  iosOutputTracked,
  planClean,
  refusal,
  removeItems,
  sizeOf,
} from '../../src/lib/clean'

let base: string
let root: string

/** Create a file (and its dirs) under the repo root. */
const file = (path: string, content = 'x') => {
  const abs = join(root, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

const parse = (c: Partial<KitConfigInput> = {}) =>
  configSchema.parse({
    name: 'x',
    gradle: { root: 'apps/client' },
    targets: {
      api: { kind: 'worker', dir: 'apps/api' },
      web: { kind: 'astro', dir: 'apps/web' },
      client: { kind: 'gradle', dir: 'apps/client' },
    },
    ...c,
  })

const labels = (plan: { items: { label: string }[] }) => plan.items.map((i) => i.label).sort()

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink, and the tests compare absolute paths.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'kit-clean-')))
  root = join(base, 'repo')
  file('apps/client/settings.gradle.kts')
  file('apps/client/build/out.jar', 'x'.repeat(100))
  file('apps/client/.gradle/cache.bin')
  file('apps/client/shared/build.gradle.kts')
  file('apps/client/shared/build/classes/A.class')
  file('apps/client/shared/src/main/kotlin/app/build/Keep.kt')
  file('apps/client/tools/build/not-a-project.txt')
  file('apps/api/dist/worker.js')
  file('apps/api/.wrangler/tmp/bundle.js')
  file('apps/api/.wrangler/state/v3/d1/db.sqlite')
  file('apps/api/src/index.ts')
  file('apps/web/.astro/types.d.ts')
  file('apps/web/node_modules/.vite/deps.json')
  file('node_modules/pkg/index.js')
  file('.kit/node_modules/kit/index.js')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('planClean', () => {
  test('per kind: gradle build dirs and .gradle, JS output and caches', () => {
    const plan = planClean(root, parse())
    expect(plan.refused).toEqual([])
    expect(labels(plan)).toEqual([
      'apps/api/.wrangler/tmp',
      'apps/api/dist',
      'apps/client/.gradle',
      'apps/client/build',
      'apps/client/shared/build',
      'apps/web/.astro',
      'apps/web/node_modules/.vite',
    ])
    expect(plan.items.find((i) => i.label === 'apps/client/build')).toMatchObject({
      bytes: 100,
      owner: 'client',
    })
  })

  test('named targets only', () => {
    expect(labels(planClean(root, parse(), { targets: ['api'] }))).toEqual([
      'apps/api/.wrangler/tmp',
      'apps/api/dist',
    ])
    expect(() => planClean(root, parse(), { targets: ['nope'] })).toThrow(/Unknown target/)
  })

  test('kotlin toolchain: build/ in the toolchain root', () => {
    const c = parse({
      gradle: undefined,
      toolchain: { root: 'apps/client' },
      targets: { client: { kind: 'kotlin', dir: 'apps/client' } },
    })
    expect(labels(planClean(root, c))).toEqual(['apps/client/build'])
  })

  test('--deep adds node_modules and .wrangler/state, which is named as local data', () => {
    const plan = planClean(root, parse(), { deep: true })
    expect(labels(plan)).toEqual([
      '.kit/node_modules',
      'apps/api/.wrangler/state',
      'apps/api/.wrangler/tmp',
      'apps/api/dist',
      'apps/client/.gradle',
      'apps/client/build',
      'apps/client/shared/build',
      'apps/web/.astro',
      'apps/web/node_modules/.vite',
      'node_modules',
    ])
    expect(plan.items.find((i) => i.label === 'apps/api/.wrangler/state')).toMatchObject({
      deep: true,
      note: 'local D1/KV data',
    })
    // Root node_modules stays when only a target is named.
    expect(labels(planClean(root, parse(), { deep: true, targets: ['api'] }))).not.toContain('node_modules')
  })

  test('a path inside another planned path is listed once', () => {
    const c = parse({ gradle: undefined, targets: { site: { kind: 'vite', dir: '.' } } })
    file('node_modules/.vite/deps.json')
    file('dist/index.html')
    expect(labels(planClean(root, c, { deep: true }))).toEqual(['.kit/node_modules', 'dist', 'node_modules'])
  })

  describe('iOS release output', () => {
    const iosConfig = (output: string) =>
      parse({
        release: {
          ios: { bundleIds: ['a.b'], project: 'apps/client/ios/App.xcodeproj', scheme: 'App', output },
        },
      })
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
    }
    /** Plan the way the command does: ask git first. */
    const plan = async (output: string, opts: { targets?: string[] } = {}) => {
      const c = iosConfig(output)
      return planClean(root, c, { ...opts, outputTracked: await iosOutputTracked(root, c) })
    }
    const repo = (...tracked: string[]) => {
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'kit@example.com')
      git('config', 'user.name', 'kit')
      git('config', 'commit.gpgsign', 'false')
      git('add', 'apps/api/src/index.ts', ...tracked)
      git('commit', '-q', '-m', 'chore: init')
    }

    test.each(['fastlane', 'ios'])(
      '%s/App.ipa: only the .ipa and its dSYM zip, never the dir',
      async (dir) => {
        file(`${dir}/Fastfile`)
        file(`${dir}/metadata/en-US/description.txt`)
        file(`${dir}/App.ipa`)
        file(`${dir}/App.app.dSYM.zip`)
        file(`${dir}/Other.ipa`)
        repo(`${dir}/Fastfile`, `${dir}/metadata/en-US/description.txt`)
        const p = await plan(`${dir}/App.ipa`)
        expect(labels(p).filter((l) => l.startsWith(dir))).toEqual([
          `${dir}/App.app.dSYM.zip`,
          `${dir}/App.ipa`,
        ])
        expect(removeItems(root, p.items).failed).toEqual([])
        expect(existsSync(join(root, dir, 'Fastfile'))).toBe(true)
        expect(existsSync(join(root, dir, 'metadata/en-US/description.txt'))).toBe(true)
        expect(existsSync(join(root, dir, 'Other.ipa'))).toBe(true)
        expect(existsSync(join(root, dir, 'App.ipa'))).toBe(false)
      },
    )

    test('tracked files deleted from the working tree still keep the dir', async () => {
      file('fastlane/Fastfile')
      file('fastlane/App.ipa')
      repo('fastlane/Fastfile')
      rmSync(join(root, 'fastlane/Fastfile'))
      expect(labels(await plan('fastlane/App.ipa'))).toContain('fastlane/App.ipa')
      expect(labels(await plan('fastlane/App.ipa'))).not.toContain('fastlane')
    })

    test('a dedicated untracked build dir goes with its artifacts', async () => {
      file('build/ios/App.ipa')
      file('build/ios/App.app.dSYM.zip')
      repo()
      expect(labels(await plan('build/ios/App.ipa'))).toContain('build/ios')
      // Anything else in it: only the artifacts.
      file('build/ios/notes.txt')
      const p = labels(await plan('build/ios/App.ipa'))
      expect(p).toContain('build/ios/App.ipa')
      expect(p).toContain('build/ios/App.app.dSYM.zip')
      expect(p).not.toContain('build/ios')
      // Not when only a JS target is named.
      expect(labels(await plan('build/ios/App.ipa', { targets: ['api'] })).join()).not.toContain('build/ios')
    })

    test('the dir is kept when git cannot say (no repo) or was not asked; the repo root never goes', async () => {
      file('build/ios/App.ipa')
      const c = iosConfig('build/ios/App.ipa')
      expect(await iosOutputTracked(root, c)).toBe(true)
      expect(labels(planClean(root, c))).toContain('build/ios/App.ipa')
      expect(labels(planClean(root, c))).not.toContain('build/ios')
      file('App.ipa')
      const atRoot = planClean(root, iosConfig('App.ipa'), { outputTracked: false })
      expect(labels(atRoot)).toContain('App.ipa')
      expect(atRoot.items.every((i) => i.path !== root)).toBe(true)
    })
  })

  test('--deep: DerivedData of the configured project only', () => {
    const project = join(root, 'apps/client/ios/App.xcodeproj')
    mkdirSync(project, { recursive: true })
    const home = join(base, 'home')
    const dd = join(home, 'Library/Developer/Xcode/DerivedData')
    const plist = (path: string) =>
      `<?xml version="1.0"?><plist><dict><key>LastAccessedDate</key><date>2026-01-01</date><key>WorkspacePath</key>\n<string>${path}</string></dict></plist>`
    for (const [name, path] of [
      ['App-aaaa', project],
      ['App-bbbb', '/somewhere/else/App.xcodeproj'],
      ['Other-cccc', project],
    ] as const) {
      mkdirSync(join(dd, name), { recursive: true })
      writeFileSync(join(dd, name, 'info.plist'), plist(path))
    }
    mkdirSync(join(dd, 'App-dddd'))
    expect(derivedDataDirs(project, home)).toEqual([join(dd, 'App-aaaa')])

    const c = parse({
      release: {
        ios: {
          bundleIds: ['a.b'],
          project: 'apps/client/ios/App.xcodeproj',
          scheme: 'App',
          output: 'o/App.ipa',
        },
      },
    })
    const item = planClean(root, c, { deep: true, home }).items.find((i) => i.external)
    expect(item).toMatchObject({ path: join(dd, 'App-aaaa'), label: join(dd, 'App-aaaa'), deep: true })
    expect(planClean(root, c, { home }).items.some((i) => i.external)).toBe(false)
  })
})

describe('outside the repo root', () => {
  test('refusal: by name, through a symlinked parent, and for a symlink itself', () => {
    const outside = join(base, 'outside')
    mkdirSync(join(outside, 'tmp'), { recursive: true })
    expect(refusal(root, outside)).toBe('outside the repo root')
    expect(refusal(root, join(root, '../outside/tmp'))).toBe('outside the repo root')
    expect(refusal(root, root)).toBe('outside the repo root')
    expect(refusal(root, join(root, 'apps/api/dist'))).toBeUndefined()

    symlinkSync(outside, join(root, 'apps/web/linked'))
    expect(refusal(root, join(root, 'apps/web/linked'))).toBe('a symlink')
    expect(refusal(root, join(root, 'apps/web/linked/tmp'))).toBe(
      'resolves outside the repo root through a symlink',
    )
  })

  test('a gradle root outside the repo is refused, not walked', () => {
    file('../elsewhere/settings.gradle.kts')
    file('../elsewhere/build/out.jar')
    const plan = planClean(root, parse({ gradle: { root: '../elsewhere' } }), { targets: ['client'] })
    expect(plan.items).toEqual([])
    expect(plan.refused).toEqual([{ path: join(base, 'elsewhere'), reason: 'outside the repo root' }])
  })

  test('symlinked output is refused and what it points at survives', () => {
    const outside = join(base, 'outside')
    file('../outside/dist/keep.js')
    file('../outside/wrangler/tmp/keep.js')
    rmSync(join(root, 'apps/api/dist'), { recursive: true })
    rmSync(join(root, 'apps/api/.wrangler'), { recursive: true })
    symlinkSync(join(outside, 'dist'), join(root, 'apps/api/dist'))
    symlinkSync(join(outside, 'wrangler'), join(root, 'apps/api/.wrangler'))

    const plan = planClean(root, parse(), { targets: ['api'], deep: true })
    expect(plan.items).toEqual([])
    expect(plan.refused).toEqual([
      { path: join(root, 'apps/api/dist'), reason: 'a symlink' },
      {
        path: join(root, 'apps/api/.wrangler/tmp'),
        reason: 'resolves outside the repo root through a symlink',
      },
    ])
    expect(existsSync(join(outside, 'dist/keep.js'))).toBe(true)
  })

  test('removeItems checks again: a path swapped for a symlink after planning is not followed', () => {
    const outside = join(base, 'outside')
    file('../outside/keep.js')
    const { items } = planClean(root, parse(), { targets: ['api'] })
    rmSync(join(root, 'apps/api/dist'), { recursive: true })
    symlinkSync(outside, join(root, 'apps/api/dist'))
    const out = removeItems(root, items)
    expect(out.removed.map((i) => i.label)).toEqual(['apps/api/.wrangler/tmp'])
    expect(out.failed.map((f) => [f.item.label, f.error])).toEqual([['apps/api/dist', 'a symlink']])
    expect(existsSync(join(outside, 'keep.js'))).toBe(true)
  })

  test('symlinks inside planned output are removed as links, not followed', () => {
    file('../outside/keep.js')
    symlinkSync(join(base, 'outside'), join(root, 'apps/api/dist/link'))
    const { items } = planClean(root, parse(), { targets: ['api'] })
    expect(removeItems(root, items).failed).toEqual([])
    expect(existsSync(join(root, 'apps/api/dist'))).toBe(false)
    expect(existsSync(join(base, 'outside/keep.js'))).toBe(true)
  })
})

describe('helpers', () => {
  test('gradleBuildDirs: only next to a build or settings script, never under src', () => {
    expect(gradleBuildDirs(join(root, 'apps/client')).sort()).toEqual([
      join(root, 'apps/client/build'),
      join(root, 'apps/client/shared/build'),
    ])
  })
  test('removeItems deletes and reports', () => {
    const { items } = planClean(root, parse())
    const out = removeItems(root, items)
    expect(out.failed).toEqual([])
    expect(out.removed).toHaveLength(items.length)
    expect(existsSync(join(root, 'apps/client/build'))).toBe(false)
    expect(existsSync(join(root, 'apps/client/shared/src/main/kotlin/app/build/Keep.kt'))).toBe(true)
    expect(existsSync(join(root, 'apps/client/tools/build/not-a-project.txt'))).toBe(true)
    expect(existsSync(join(root, 'apps/api/src/index.ts'))).toBe(true)
    expect(existsSync(join(root, 'apps/api/.wrangler/state/v3/d1/db.sqlite'))).toBe(true)
    expect(existsSync(join(root, 'node_modules/pkg/index.js'))).toBe(true)
  })
  test('sizeOf and formatBytes', () => {
    expect(sizeOf(join(root, 'apps/client/build'))).toBe(100)
    expect(sizeOf(join(root, 'nope'))).toBe(0)
    expect([0, 512, 1536, 150 * 1024, 5 * 1024 ** 2, 3.25 * 1024 ** 3].map(formatBytes)).toEqual([
      '0 B',
      '512 B',
      '1.5 KB',
      '150 KB',
      '5.0 MB',
      '3.3 GB',
    ])
  })
})
