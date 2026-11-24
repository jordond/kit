import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KitConfig } from '../../src/config/schema'
import { checkXcconfigOwnership as doctorCheck } from '../../src/lib/doctor/checks'
import {
  builtinPreflights,
  checkSwiftPMLinkage,
  checkXcconfigOwnership,
} from '../../src/lib/release/builtin-preflights'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-builtin-'))
  dirs.push(root)
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  return root
}

const config = {
  gradle: { root: 'app' },
  release: {
    ios: {
      bundleIds: ['a.b'],
      project: 'app/ios/App.xcodeproj',
      scheme: 'App',
      output: 'out',
      xcconfig: 'app/ios/Configuration/Config.xcconfig',
    },
  },
} as unknown as KitConfig

const PBX = 'app/ios/App.xcodeproj/project.pbxproj'

describe('xcconfig ownership', () => {
  test('flags keys set in both, ignoring comments and unrelated keys', () => {
    const root = repo({
      [PBX]: '\t\t\t\tMARKETING_VERSION = 1.0;\n\t\t\t\t"INFOPLIST_KEY_X[sdk=ios*]" = y;\n',
      'app/ios/Configuration/Config.xcconfig':
        '// MARKETING_VERSION = 9\nMARKETING_VERSION = 2\nINFOPLIST_KEY_X = a\nOTHER = 1\n',
    })
    const msg = checkXcconfigOwnership(root, config)
    expect(msg).toContain('MARKETING_VERSION (Config.xcconfig)')
    expect(msg).toContain('INFOPLIST_KEY_X (Config.xcconfig)')
    expect(msg).not.toContain('OTHER')
  })

  test('clean when no overlap; not applicable without files', () => {
    const root = repo({ [PBX]: 'FOO = 1;', 'app/ios/Configuration/Config.xcconfig': 'BAR = 1\n' })
    expect(checkXcconfigOwnership(root, config)).toBeUndefined()
    expect(checkXcconfigOwnership(repo({}), config)).toBeUndefined()
  })

  test('doctor wrapper maps the problem to a check', () => {
    expect(doctorCheck(() => undefined).status).toBe('ok')
    expect(doctorCheck(() => 'clash').status).toBe('fail')
  })
})

describe('swiftpm linkage', () => {
  const LINK = 'app/ios/KotlinMultiplatformLinkedPackage'
  const files = {
    [`${LINK}/Package.swift`]: 'path: "subpackages/live_1_0"',
    [`${LINK}/subpackages/live_1_0/x`]: '',
    [`${LINK}/subpackages/dead_0_9/x`]: '',
  }

  test('registers by detection and honours swiftpmLinkage: false', async () => {
    const root = repo(files)
    expect(builtinPreflights(root, config).map((p) => p.skipFlag)).toEqual(['swiftpm-linkage'])
    const off = {
      ...config,
      release: { ...config.release, ios: { ...config.release!.ios!, swiftpmLinkage: false } },
    } as KitConfig
    expect(builtinPreflights(root, off)).toEqual([])
    expect(await checkSwiftPMLinkage(repo({}), config)).toBeUndefined()
  })

  test('prunes stale subpackages, passes when git is clean', async () => {
    const root = repo(files)
    const tasks: string[] = []
    const out = await checkSwiftPMLinkage(root, config, {
      gradle: async (t) => (tasks.push(t), 0),
      porcelain: async () => '',
    })
    expect(out).toBeUndefined()
    expect(tasks).toEqual([':shared:integrateLinkagePackage'])
    expect(existsSync(join(root, LINK, 'subpackages/dead_0_9'))).toBe(false)
    expect(existsSync(join(root, LINK, 'subpackages/live_1_0'))).toBe(true)
  })

  test('drift re-resolves the graph then fails with the diff', async () => {
    let resolved = 0
    const out = await checkSwiftPMLinkage(repo(files), config, {
      gradle: async () => 0,
      porcelain: async () => ' M app/ios/KotlinMultiplatformLinkedPackage/Package.swift\n',
      resolve: async () => void resolved++,
    })
    expect(out).toContain('not what')
    expect(out).toContain('Package.swift')
    expect(resolved).toBe(1)
  })

  test('a failing gradle task fails the check', async () => {
    const out = await checkSwiftPMLinkage(repo(files), config, { gradle: async () => 1 })
    expect(out).toContain('failed')
  })
})
