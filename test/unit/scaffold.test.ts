import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configSchema } from '../../src/config/schema'
import {
  detectToolchain,
  type FileAction,
  isToolchainRepo,
  kitPackageJson,
  moduleProduct,
  planScaffold,
  projectModules,
  type ScaffoldInput,
  toolchainConfig,
  withGitignore,
  withKitDependency,
  withVersionKeys,
} from '../../src/lib/scaffold'

const FIXTURE = resolve(import.meta.dir, '../fixtures/new-toolchain')
const glob = (dir: string) => [...new Bun.Glob('**/*').scanSync({ cwd: join(FIXTURE, dir), onlyFiles: true })]
const disk: Record<string, string> = Object.fromEntries(
  glob('.').map((f) => [f, readFileSync(join(FIXTURE, f), 'utf8')]),
)
const reader = (files: Record<string, string>) => (p: string) => files[p]
const lister = (files: Record<string, string>) => (dir: string) =>
  Object.keys(files).filter((f) => f.startsWith(`${dir}/`))

describe('toolchain project detection', () => {
  test('a toolchain repo has the wrapper and project.yaml', () => {
    expect(isToolchainRepo((p) => p in disk)).toBe(true)
    expect(isToolchainRepo((p) => p === 'kotlin')).toBe(false)
    expect(isToolchainRepo(() => false)).toBe(false)
  })

  test('projectModules reads plain entries and skips globs', () => {
    expect(
      projectModules('modules:\n  - ./app/\n  # note\n  - "shared" # lib\n  - libs/*\n\nother: 1\n'),
    ).toEqual(['app', 'shared'])
    expect(projectModules('plugins:\n  - x\n')).toEqual([])
    expect(projectModules('modules: [./a, "b/", libs/*]\n')).toEqual(['a', 'b'])
  })

  test('moduleProduct: short form, block form, flow form, block list', () => {
    expect(moduleProduct('product: jvm/app\n')).toEqual({ type: 'jvm/app', platforms: [] })
    expect(moduleProduct('product:\n  type: kmp/lib\n  platforms: [jvm, android]\n')).toEqual({
      type: 'kmp/lib',
      platforms: ['jvm', 'android'],
    })
    expect(moduleProduct('product: { type: kmp/lib, platforms: [jvm, wasmJs] }\n')).toEqual({
      type: 'kmp/lib',
      platforms: ['jvm', 'wasmJs'],
    })
    expect(
      moduleProduct('product:\n  type: kmp/lib\n  platforms:\n    - jvm\n    - iosArm64\nsettings: {}\n'),
    ).toEqual({
      type: 'kmp/lib',
      platforms: ['jvm', 'iosArm64'],
    })
  })

  test('detectToolchain finds the app modules, ids, the Xcode project and the Linux platforms', () => {
    expect(detectToolchain(reader(disk), lister(disk))).toEqual({
      android: { module: 'androidApp', packageName: 'app.example.demo', versionName: '0.3.0' },
      desktop: 'desktopApp',
      ios: {
        module: 'iosApp',
        project: 'iosApp/module.xcodeproj',
        scheme: 'app',
        bundleId: 'app.example.demo',
        teamId: 'ABCDE12345',
        xcconfig: 'iosApp/Configuration/Config.xcconfig',
        version: '0.2.0',
      },
      ciPlatforms: ['jvm', 'android', 'wasmJs'],
    })
  })

  test('modules under other directories: the config gets the path, `-m` the basename', () => {
    const files = {
      'project.yaml': 'modules:\n  - mobile/android\n  - mobile/*\n  - tools/licences\n',
      'mobile/android/module.yaml':
        'product: android/app\nsettings:\n  android:\n    applicationId: com.example\n',
      'mobile/desktop/module.yaml': 'product: jvm/app\n',
      'mobile/ios/module.yaml': 'product: ios/app\n',
      'mobile/ios/module.xcodeproj/project.pbxproj': '',
      'mobile/core/module.yaml': 'product:\n  type: kmp/lib\n  platforms: [jvm, android]\n',
      'mobile/fastlane/Fastfile': '',
      'tools/licences/module.yaml': 'product: jvm/lib\n',
    }
    const facts = detectToolchain(reader(files), lister(files))
    expect(facts).toMatchObject({
      android: { module: 'mobile/android', packageName: 'com.example' },
      desktop: 'desktop',
      ios: { module: 'mobile/ios', project: 'mobile/ios/module.xcodeproj' },
    })
    const text = toolchainConfig('App', facts)
    expect(text).toContain("module: 'mobile/android',")
    expect(text).toContain("dev: './kotlin run -m desktop'")
    expect(text).toContain("project: 'mobile/ios/module.xcodeproj',")
  })

  test('nothing to find: no release block, no platform filter', () => {
    const facts = detectToolchain(
      reader({ 'project.yaml': 'modules:\n  - lib\n', 'lib/module.yaml': 'product: jvm/lib\n' }),
      () => [],
    )
    expect(facts).toEqual({ ciPlatforms: ['jvm'] })
    const text = toolchainConfig('Lib', facts)
    expect(text).not.toContain('release')
    expect(text).toContain("app: { kind: 'kotlin', dir: '.' },")
  })
})

const tmp = mkdtempSync(join(tmpdir(), 'kit-scaffold-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let n = 0
const evalConfig = async (text: string) => {
  // defineConfig is the identity; drop the import so the file loads from a temp dir. One dir per
  // file: Bun caches directory listings, so a file added to a dir it has read is not found.
  const dir = join(tmp, String(n++))
  mkdirSync(dir)
  const file = join(dir, 'config.mjs')
  writeFileSync(file, text.replace(/^import .*\n/, '').replace('defineConfig(', '('))
  return (await import(file)).default
}

describe('toolchainConfig', () => {
  test('validates, with the detected values', async () => {
    const config = configSchema.parse(
      await evalConfig(toolchainConfig('Demo', detectToolchain(reader(disk), lister(disk)))),
    )
    expect(config.toolchain).toEqual({ root: '.' })
    expect(config.targets?.app).toMatchObject({ kind: 'kotlin', dir: '.', dev: './kotlin run -m desktopApp' })
    expect(config.release?.android).toEqual({ packageName: 'app.example.demo', module: 'androidApp' })
    expect(config.release?.ios).toEqual({
      bundleIds: ['app.example.demo'],
      project: 'iosApp/module.xcodeproj',
      scheme: 'app',
      output: 'Demo.ipa',
      teamId: 'ABCDE12345',
      xcconfig: 'iosApp/Configuration/Config.xcconfig',
    })
  })

  test('ids kit cannot find become com.example placeholders', async () => {
    const config = configSchema.parse(
      await evalConfig(
        toolchainConfig("Jo's App", {
          android: { module: 'androidApp' },
          ios: { module: 'iosApp', project: 'iosApp/module.xcodeproj', scheme: 'app' },
          ciPlatforms: [],
        }),
      ),
    )
    expect(config.name).toBe("Jo's App")
    expect(config.release?.android?.packageName).toBe('com.example.josapp')
    expect(config.release?.ios?.bundleIds).toEqual(['com.example.josapp'])
  })
})

describe('file edits', () => {
  test('withGitignore adds only what is missing', () => {
    expect(withGitignore(undefined, ['node_modules/', '.env'])).toBe('node_modules/\n.env\n')
    expect(withGitignore('/build/\n.env', ['node_modules/', '.env'])).toBe('/build/\n.env\nnode_modules/\n')
    expect(withGitignore('node_modules\n/.env\n', ['node_modules/', '.env'])).toBeUndefined()
  })

  test('withVersionKeys inserts under [versions] and leaves existing keys', () => {
    const keys = { 'app-android-version': '0.3.0', 'app-ios-version': '0.2.0' }
    expect(withVersionKeys('[versions]\nfoo = "1"\n\n[libraries]\n', keys)).toBe(
      '[versions]\napp-android-version = "0.3.0"\napp-ios-version = "0.2.0"\nfoo = "1"\n\n[libraries]\n',
    )
    expect(withVersionKeys('[versions]\napp-android-version = "9.0.0"\n', keys)).toBe(
      '[versions]\napp-ios-version = "0.2.0"\napp-android-version = "9.0.0"\n',
    )
    expect(withVersionKeys(undefined, keys)).toBe(
      '[versions]\napp-android-version = "0.3.0"\napp-ios-version = "0.2.0"\n',
    )
    expect(withVersionKeys('[libraries]\n', keys)).toStartWith('[versions]\napp-android-version = "0.3.0"')
    expect(
      withVersionKeys('[versions]\napp-android-version = "1"\napp-ios-version = "1"\n', keys),
    ).toBeUndefined()
  })

  test('kitPackageJson pins the running kit', () => {
    expect(JSON.parse(kitPackageJson('My App', '1.2.3', '^4.0.0'))).toEqual({
      name: 'my-app',
      private: true,
      type: 'module',
      devDependencies: { '@jordond/kit': '^1.2.3', zod: '^4.0.0' },
    })
  })
})

describe('planScaffold', () => {
  const input = (over: Partial<ScaffoldInput> = {}): ScaffoldInput => ({
    template: 'toolchain',
    name: 'Demo',
    kitVersion: '1.2.3',
    kitRef: `${'a'.repeat(40)} # v1.2.3`,
    zod: '^4.0.0',
    files: {
      '.github/workflows/ci.yml':
        'uses: jordond/kit/.github/actions/setup@{{kitRef}}\nrun: kit test{{platformArgs}}\n',
      'fastlane/Fastfile': 'import\n',
      '.env.example': 'A=\n',
    },
    read: reader(disk),
    list: lister(disk),
    ...over,
  })
  const summary = (plan: FileAction[]) => plan.map((a) => `${a.kind} ${a.path}`)
  const content = (plan: FileAction[], path: string) => {
    const a = plan.find((x) => x.path === path)
    return a && a.kind !== 'skip' ? a.content : undefined
  }

  test('toolchain: kit in .kit/, never a root package.json; catalog and .gitignore gain lines', () => {
    const plan = planScaffold(input())
    expect(summary(plan)).toEqual([
      'write .kit/package.json',
      'write .kit/kit.config.ts',
      'write .env.example',
      'write .github/workflows/ci.yml',
      'write fastlane/Fastfile',
      'write .gitignore',
      'edit libs.versions.toml',
    ])
    expect(plan.some((a) => a.path === 'package.json')).toBe(false)
    expect(content(plan, '.github/workflows/ci.yml')).toBe(
      `uses: jordond/kit/.github/actions/setup@${'a'.repeat(40)} # v1.2.3\nrun: kit test -- --platform jvm --platform android --platform wasmJs\n`,
    )
    // The versions the project already builds with.
    expect(content(plan, 'libs.versions.toml')).toStartWith(
      '[versions]\napp-android-version = "0.3.0"\napp-ios-version = "0.2.0"\nlogback',
    )
  })

  test('existing files are never overwritten', () => {
    const files = {
      ...disk,
      '.kit/package.json': '{}',
      '.env.example': 'MINE=\n',
      '.gitignore': 'node_modules/\n.env\nbackups/\n',
      'libs.versions.toml': '[versions]\napp-android-version = "1"\napp-ios-version = "1"\n',
    }
    expect(summary(planScaffold(input({ read: reader(files), list: lister(files) })))).toEqual([
      'edit .kit/package.json',
      'write .kit/kit.config.ts',
      'skip .env.example',
      'write .github/workflows/ci.yml',
      'write fastlane/Fastfile',
    ])
  })

  test('renovate.json is written unless the repo has a Renovate config somewhere', () => {
    const files = { 'renovate.json': '{}\n' }
    expect(summary(planScaffold(input({ files })))).toContain('write renovate.json')
    for (const present of ['renovate.json', '.github/renovate.json5', '.renovaterc']) {
      const on = { ...disk, [present]: '{}' }
      const plan = planScaffold(input({ files, read: reader(on), list: lister(on) }))
      expect(plan.find((a) => a.path === 'renovate.json')).toEqual({
        kind: 'skip',
        path: 'renovate.json',
        reason: present === 'renovate.json' ? 'exists' : `${present} exists`,
      })
    }
  })

  test('an existing package.json without kit gains the dependency, and keeps the rest', () => {
    const files = { 'package.json': '{ "name": "mine", "devDependencies": { "typescript": "^5" } }' }
    const plan = planScaffold(input({ template: 'gradle', files: {}, read: reader(files) }))
    expect(plan[0]).toMatchObject({ kind: 'edit', path: 'package.json' })
    expect(JSON.parse(content(plan, 'package.json')!)).toEqual({
      name: 'mine',
      devDependencies: { typescript: '^5', '@jordond/kit': '^1.2.3', zod: '^4.0.0' },
    })
    expect(
      withKitDependency('{ "dependencies": { "@jordond/kit": "1.0.0" } }', '1.2.3', '^4'),
    ).toBeUndefined()
    expect(withKitDependency('not json', '1.2.3', '^4')).toBeUndefined()
  })

  test('gradle: kit in the root package.json, config from the template', () => {
    const plan = planScaffold(
      input({ template: 'gradle', files: { 'kit.config.ts': "name: '{{name}}'\n" }, read: () => undefined }),
    )
    expect(summary(plan)).toEqual(['write package.json', 'write kit.config.ts', 'write .gitignore'])
    expect(content(plan, 'kit.config.ts')).toBe("name: 'Demo'\n")
  })
})
