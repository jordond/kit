import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema, type KitConfig } from '../../src/config/schema'
import { ExitCode, KitError } from '../../src/lib/errors'
import {
  appAndroidModule,
  appIosModule,
  moduleYaml,
  releaseAndroidModule,
  requireModule,
  resolveModule,
  toolchainTaskDir,
} from '../../src/lib/module'

const cfg = (c: unknown) => c as KitConfig
const toolchain = cfg({ toolchain: { root: '.' } })
const gradle = cfg({ gradle: { root: 'client' } })
const KEY = 'release.android.module'
const at = (config: KitConfig, ref: Parameters<typeof resolveModule>[2], root = '/r') => {
  const { dir, name } = resolveModule(root, config, ref, KEY)
  return { dir, name }
}

describe('resolveModule: Kotlin toolchain', () => {
  test('a root-level module: the directory is the name', () => {
    expect(at(toolchain, 'androidApp')).toEqual({ dir: 'androidApp', name: 'androidApp' })
  })

  test('a nested module: the name is the basename, at any depth', () => {
    expect(at(toolchain, 'mobile/android')).toEqual({ dir: 'mobile/android', name: 'android' })
    expect(at(toolchain, './apps/shop/clients/android/')).toEqual({
      dir: 'apps/shop/clients/android',
      name: 'android',
    })
  })

  test('the location is relative to toolchain.root', () => {
    expect(at(cfg({ toolchain: { root: 'client' } }), 'mobile/android')).toEqual({
      dir: 'client/mobile/android',
      name: 'android',
    })
  })

  test('an explicit name overrides the basename rule', () => {
    expect(at(toolchain, { path: 'apps/phone', name: 'android' })).toEqual({
      dir: 'apps/phone',
      name: 'android',
    })
    expect(at(toolchain, { path: 'mobile/android' })).toEqual({ dir: 'mobile/android', name: 'android' })
  })

  test('a Gradle-style value is still a location', () => {
    expect(at(toolchain, ':androidApp')).toEqual({ dir: 'androidApp', name: 'androidApp' })
    expect(at(toolchain, ':apps:android')).toEqual({ dir: 'apps/android', name: 'android' })
  })

  test('a module at the toolchain root is named after that directory', () => {
    expect(at(toolchain, '.', '/work/shop')).toEqual({ dir: '.', name: 'shop' })
    expect(at(cfg({ toolchain: { root: 'client' } }), '.', '/work/shop')).toEqual({
      dir: 'client',
      name: 'client',
    })
  })

  test('module.yaml and the task dir come from the resolved module', () => {
    const m = resolveModule('/r', toolchain, 'mobile/android', KEY)
    expect(moduleYaml(m)).toBe('mobile/android/module.yaml')
    expect(toolchainTaskDir('/r', m, 'bundleAndroid')).toBe('/r/build/tasks/_android_bundleAndroid')
  })
})

describe('resolveModule: Gradle', () => {
  test(':a is the project path; its directory is Gradle’s default', () => {
    expect(at(gradle, ':app')).toEqual({ dir: 'client/app', name: ':app' })
    expect(at(gradle, ':android')).toEqual({ dir: 'client/android', name: ':android' })
  })

  test(':a:b', () => {
    expect(at(gradle, ':apps:android')).toEqual({ dir: 'client/apps/android', name: ':apps:android' })
  })

  test('a directory gives the project path', () => {
    expect(at(gradle, 'android')).toEqual({ dir: 'client/android', name: ':android' })
    expect(at(gradle, 'apps/android')).toEqual({ dir: 'client/apps/android', name: ':apps:android' })
  })

  test('an explicit name covers a project whose directory is remapped in settings.gradle', () => {
    expect(at(gradle, { path: 'apps/android', name: ':app' })).toEqual({
      dir: 'client/apps/android',
      name: ':app',
    })
    expect(at(gradle, { path: 'apps/android', name: 'app' }).name).toBe(':app')
  })

  test('Gradle wins when both builds are configured; a caller can ask for one', () => {
    const both = cfg({ gradle: { root: 'g' }, toolchain: { root: 't' } })
    expect(resolveModule('/r', both, 'a/b', KEY)).toMatchObject({
      kind: 'gradle',
      dir: 'g/a/b',
      name: ':a:b',
    })
    expect(resolveModule('/r', both, 'a/b', KEY, 'toolchain')).toMatchObject({
      kind: 'toolchain',
      dir: 't/a/b',
      name: 'b',
    })
  })
})

describe('resolveModule: bad values', () => {
  const exit = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      return e instanceof KitError ? e.exitCode : e
    }
  }
  test('empty, absolute, or no native build are config errors', () => {
    expect(exit(() => at(toolchain, ' '))).toBe(ExitCode.config)
    expect(exit(() => at(toolchain, '/abs/android'))).toBe(ExitCode.config)
    expect(exit(() => at(cfg({}), ':android'))).toBe(ExitCode.config)
  })

  test('the schema takes a string or { path, name? } and nothing else', () => {
    const parse = (module: unknown) =>
      configSchema.safeParse({
        name: 'X',
        toolchain: { root: '.' },
        release: { android: { packageName: 'p', module } },
        app: { android: { module }, ios: { module } },
      }).success
    expect(parse('mobile/android')).toBe(true)
    expect(parse({ path: 'mobile/android' })).toBe(true)
    expect(parse({ path: 'apps/phone', name: 'android' })).toBe(true)
    expect(parse({ name: 'android' })).toBe(false)
    expect(parse({ path: 'a', dir: 'b' })).toBe(false)
    expect(parse('')).toBe(false)
  })
})

describe('the config entry points', () => {
  test('app.android.module wins over release.android.module, and each names its own key', () => {
    const c = cfg({
      toolchain: { root: '.' },
      release: { android: { packageName: 'p', module: 'mobile/android' } },
      app: { android: { module: 'mobile/demo' } },
    })
    expect(releaseAndroidModule('/r', c)).toMatchObject({ key: 'release.android.module', name: 'android' })
    expect(appAndroidModule('/r', c)).toMatchObject({
      key: 'app.android.module',
      dir: 'mobile/demo',
      name: 'demo',
    })
    expect(appAndroidModule('/r', cfg({ ...c, app: undefined }))).toMatchObject({
      key: 'release.android.module',
      dir: 'mobile/android',
    })
    expect(releaseAndroidModule('/r', toolchain)).toBeUndefined()
  })

  test('iOS: the directory holding the project, unless app.ios.module says otherwise', () => {
    // `project` is repo-relative already: toolchain.root is not joined onto it again.
    const c = cfg({ toolchain: { root: 'client' } })
    expect(appIosModule('/r', c, 'client/mobile/ios/module.xcodeproj')).toMatchObject({
      dir: 'client/mobile/ios',
      name: 'ios',
    })
    const stated = cfg({ toolchain: { root: 'client' }, app: { ios: { module: 'mobile/ios' } } })
    expect(appIosModule('/r', stated, 'elsewhere/App.xcodeproj')).toMatchObject({
      key: 'app.ios.module',
      dir: 'client/mobile/ios',
      name: 'ios',
    })
  })
})

describe('requireModule', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const repo = () => {
    dir = mkdtempSync(join(tmpdir(), 'kit-module-'))
    mkdirSync(join(dir, 'mobile/android'), { recursive: true })
    writeFileSync(join(dir, 'mobile/android/module.yaml'), 'product: android/app\n')
    writeFileSync(join(dir, 'project.yaml'), 'modules:\n  - mobile/android\n  - mobile/core\n')
    return dir
  }

  test('passes a module whose module.yaml exists', () => {
    const m = resolveModule(repo(), toolchain, 'mobile/android', KEY)
    expect(requireModule(dir, toolchain, m)).toBe(m)
  })

  test('the error names the path checked, the build-tool name, the key and the listed modules', () => {
    const m = resolveModule(repo(), toolchain, 'android', KEY)
    let error: KitError | undefined
    try {
      requireModule(dir, toolchain, m)
    } catch (e) {
      error = e as KitError
    }
    expect(error).toBeInstanceOf(KitError)
    expect(error!.exitCode).toBe(ExitCode.config)
    expect(error!.message).toBe('Kotlin toolchain module not found: android/module.yaml does not exist')
    expect(error!.hint).toContain('Checked android/module.yaml (from release.android.module)')
    expect(error!.hint).toContain('`-m android`')
    expect(error!.hint).toContain(
      'Set release.android.module to the module directory, relative to toolchain.root',
    )
    expect(error!.hint).toContain('project.yaml lists: mobile/android, mobile/core')
  })

  test('a Gradle module is not checked: its directory can be remapped', () => {
    const m = resolveModule(repo(), gradle, ':nowhere', KEY)
    expect(requireModule(dir, gradle, m)).toBe(m)
  })
})
