import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkAndroidVersion,
  checkKtlint,
  checkLefthook,
  checkMise,
  checkToolchain,
} from '../../src/commands/doctor'
import { type InitState, planInit } from '../../src/commands/init'
import { installDir } from '../../src/config/load'
import { configSchema } from '../../src/config/schema'
import { checkTools } from '../../src/lib/release/mobile'
import { androidVersionDrift, setModuleVersion } from '../../src/lib/release/version'
import type { ResolvedModule } from '../../src/lib/module'
import { targetCommands } from '../../src/lib/targets'
import {
  aabFromOutput,
  findAab,
  getYamlScalar,
  keystoreProperties,
  releaseModuleYaml,
  setYaml,
  wrapperVersion,
} from '../../src/lib/toolchain'

const APP = `apply:
  - ../templates/common.module-template.yaml

product: android/app

dependencies:
  - //shared

settings:
  compose: enabled
  android:
    minSdk: 26 # keep
    namespace: app.x
`

const config = configSchema.parse({
  name: 'X',
  toolchain: { root: '.' },
  versions: { file: 'libs.versions.toml', keys: { android: 'app-android-version' } },
  targets: { app: { kind: 'kotlin', dir: '.' } },
  release: { android: { packageName: 'app.x', module: 'androidApp' } },
})

describe('module.yaml editing', () => {
  test('adds versionName, versionCode and signing inside settings.android, keeping the rest', () => {
    const out = releaseModuleYaml(APP, { version: '1.2.3', code: 42, signingProperties: '/tmp/k.properties' })
    expect(out).toBe(`apply:
  - ../templates/common.module-template.yaml

product: android/app

dependencies:
  - //shared

settings:
  compose: enabled
  android:
    minSdk: 26 # keep
    namespace: app.x
    versionName: "1.2.3"
    versionCode: 42
    signing:
      enabled: true
      propertiesFile: "/tmp/k.properties"
`)
  })

  test('replaces existing values, including a short-form or block signing', () => {
    const text = `settings:
  android:
    versionCode: 7
    versionName: '0.9.0' # old
    signing: enabled
  compose: enabled
`
    const out = releaseModuleYaml(text, { version: '1.0.0', code: 8, signingProperties: '/k' })
    expect(out).toBe(`settings:
  android:
    versionCode: 8
    versionName: "1.0.0"
    signing:
      enabled: true
      propertiesFile: "/k"
  compose: enabled
`)
    const again = releaseModuleYaml(out, { version: '1.0.1', code: 9, signingProperties: '/k2' })
    expect(getYamlScalar(again, ['settings', 'android', 'versionCode'])).toBe('9')
    expect(again.match(/signing:/g)).toHaveLength(1)
    expect(again).toContain('propertiesFile: "/k2"\n  compose: enabled')
  })

  test('creates settings and android when missing; honours 4-space indent', () => {
    expect(setYaml('product: android/app\n', ['settings', 'android', 'versionCode'], '1')).toBe(
      'product: android/app\nsettings:\n  android:\n    versionCode: 1\n',
    )
    expect(setYaml('settings:\n    compose: enabled\n', ['settings', 'android', 'versionCode'], '1')).toBe(
      'settings:\n    compose: enabled\n    android:\n      versionCode: 1\n',
    )
  })

  test('ignores settings@android and nested keys of the same name', () => {
    const text =
      'settings@android:\n  android:\n    versionName: "x"\nsettings:\n  kotlin:\n    versionName: y\n'
    expect(getYamlScalar(text, ['settings', 'android', 'versionName'])).toBeUndefined()
    expect(setModuleVersion(text, 'm.yaml', '2.0.0')).toBe(`${text}  android:\n    versionName: "2.0.0"\n`)
  })

  test('flow-style android is a config error, not a rewrite', () => {
    expect(() =>
      setYaml(
        'settings:\n  android: { minSdk: 26 }\n',
        ['settings', 'android', 'versionCode'],
        '1',
        'a/module.yaml',
      ),
    ).toThrow('a/module.yaml: settings.android is written inline')
  })

  test('getYamlScalar unquotes and drops comments', () => {
    expect(getYamlScalar(APP, ['settings', 'android', 'minSdk'])).toBe('26')
    expect(getYamlScalar('a:\n  b: "1.0" # c\n', ['a', 'b'])).toBe('1.0')
    expect(getYamlScalar('a:\n  b: x\n', ['a', 'c'])).toBeUndefined()
  })
})

test('keystoreProperties: absolute storeFile, key password = store password', () => {
  expect(keystoreProperties('/s/release.keystore', 'upload', 'p\\w')).toBe(
    'storeFile=/s/release.keystore\nstorePassword=p\\\\w\nkeyAlias=upload\nkeyPassword=p\\\\w\n',
  )
})

test('wrapperVersion', () => {
  expect(wrapperVersion('#!/bin/sh\nkotlin_cli_version=0.13.0\nkotlin_cli_sha256=ab\n')).toBe('0.13.0')
  expect(wrapperVersion('#!/bin/sh\n')).toBeUndefined()
})

describe('artifacts', () => {
  test('aabFromOutput takes the last existing path; findAab the newest under the module tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-tc-'))
    const tasks = join(dir, 'build/tasks')
    mkdirSync(join(tasks, '_androidApp_bundleAndroid'), { recursive: true })
    mkdirSync(join(tasks, '_other_bundleAndroid'), { recursive: true })
    const old = join(tasks, '_androidApp_bundleAndroid/old.aab')
    const aab = join(tasks, '_androidApp_bundleAndroid/gradle-project-release.aab')
    writeFileSync(old, '')
    writeFileSync(aab, '')
    writeFileSync(join(tasks, '_other_bundleAndroid/x.aab'), '')
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1))

    expect(
      aabFromOutput('Done.\nAAB: build/tasks/_androidApp_bundleAndroid/gradle-project-release.aab\n', dir),
    ).toBe(aab)
    expect(aabFromOutput('wrote /nope/missing.aab', dir)).toBeUndefined()
    // The task dirs carry the module's name, wherever its directory is.
    const module: ResolvedModule = {
      kind: 'toolchain',
      key: 'k',
      dir: 'mobile/androidApp',
      name: 'androidApp',
    }
    expect(findAab(dir, module)).toBe(aab)
    expect(findAab(dir, module, Date.now() + 60_000)).toBeUndefined()
    expect(findAab(join(dir, 'none'), module)).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('config', () => {
  test('gradle and toolchain are exclusive', () => {
    expect(() => configSchema.parse({ name: 'X', gradle: { root: '.' }, toolchain: { root: '.' } })).toThrow(
      'Set gradle or toolchain, not both',
    )
  })
})

describe('kotlin kind', () => {
  test('test and build run the wrapper in toolchain.root', () => {
    expect(targetCommands('/r', config, 'app', 'test')).toEqual([
      { title: 'kotlin test', cmd: ['./kotlin', 'test'], cwd: '/r' },
    ])
    expect(targetCommands('/r', config, 'app', 'build', { extra: ['-m', 'shared'] })![0]!.cmd).toEqual([
      './kotlin',
      'build',
      '-m',
      'shared',
    ])
  })
  test('--release packages the android module; --apk is refused', () => {
    expect(targetCommands('/r', config, 'app', 'build', { release: 'aab' })![0]!.cmd).toEqual([
      './kotlin',
      'package',
      '-m',
      'androidApp',
    ])
    expect(() => targetCommands('/r', config, 'app', 'build', { release: 'apk' })).toThrow('AAB only')
  })
  test('configured strings run through the shell', () => {
    const c = configSchema.parse({
      name: 'X',
      toolchain: { root: '.' },
      targets: { app: { kind: 'kotlin', dir: '.', lint: 'ktlint', dev: './kotlin run -m desktopApp' } },
    })
    expect(targetCommands('/r', c, 'app', 'lint')![0]!.cmd).toEqual(['sh', '-c', 'ktlint'])
    expect(targetCommands('/r', c, 'app', 'dev')![0]!.cmd).toEqual(['sh', '-c', './kotlin run -m desktopApp'])
  })
})

test('checkTools: a toolchain release needs no java', () => {
  const which = (b: string) => (b === 'java' ? null : `/bin/${b}`)
  expect(() => checkTools('android', which, true)).not.toThrow()
  expect(() => checkTools('android', which)).toThrow('java')
})

describe('androidVersionDrift', () => {
  const setup = (yaml: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-tc-'))
    mkdirSync(join(dir, 'androidApp'))
    writeFileSync(join(dir, 'libs.versions.toml'), '[versions]\napp-android-version = "1.2.0"\n')
    writeFileSync(join(dir, 'androidApp/module.yaml'), yaml)
    return dir
  }
  test('none when equal or unset; the mismatch otherwise', () => {
    const unset = setup(APP)
    expect(androidVersionDrift(unset, config)).toBeUndefined()
    const equal = setup(setModuleVersion(APP, 'm', '1.2.0'))
    expect(androidVersionDrift(equal, config)).toBeUndefined()
    const off = setup(setModuleVersion(APP, 'm', '1.1.0'))
    expect(androidVersionDrift(off, config)).toEqual({
      toml: '1.2.0',
      module: '1.1.0',
      file: 'androidApp/module.yaml',
    })
    expect(checkAndroidVersion(() => androidVersionDrift(off, config)).status).toBe('fail')
    for (const d of [unset, equal, off]) rmSync(d, { recursive: true, force: true })
  })
  test('a missing module.yaml is a config error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-tc-'))
    writeFileSync(join(dir, 'libs.versions.toml'), '[versions]\napp-android-version = "1.2.0"\n')
    expect(() => androidVersionDrift(dir, config)).toThrow(
      'Kotlin toolchain module not found: androidApp/module.yaml does not exist',
    )
    rmSync(dir, { recursive: true, force: true })
  })
})

test('checkToolchain', () => {
  expect(checkToolchain(undefined, undefined, false).status).toBe('skip')
  expect(checkToolchain('.', undefined, false)).toMatchObject({ status: 'fail', detail: './kotlin missing' })
  expect(checkToolchain('app/', 'x', false)).toMatchObject({
    status: 'fail',
    detail: 'app/kotlin not executable',
  })
  expect(checkToolchain('.', '#!/bin/sh\n', true).status).toBe('warn')
  expect(checkToolchain('.', 'kotlin_cli_version=0.13.0\n', true)).toMatchObject({
    status: 'ok',
    detail: '0.13.0',
  })
})

describe('init', () => {
  const state = (files: string[], over: Partial<InitState> = {}): InitState => ({
    root: '/r',
    config,
    exists: (p) => files.includes(p),
    pm: 'bun',
    accepted: [],
    self: ['kit'],
    exec: (_cwd, bin, ...args) => ['bun', 'x', bin, ...args],
    which: () => true,
    ...over,
  })
  const native = (s: InitState) => planInit(s).filter((a) => a.title.startsWith('kotlin'))

  test('bootstraps the wrapper with --version by default', () => {
    expect(native(state(['kotlin']))).toEqual([
      { kind: 'cmd', title: 'kotlin --version', cmd: ['./kotlin', '--version'], cwd: '/r' },
    ])
  })
  test('toolchain.init overrides; --js-only and a missing wrapper skip', () => {
    const c = configSchema.parse({
      name: 'X',
      toolchain: { root: 'app', init: ['show dependencies -m shared'] },
    })
    expect(native(state(['app/kotlin'], { config: c }))[0]).toMatchObject({
      cmd: ['./kotlin', 'show', 'dependencies', '-m', 'shared'],
      cwd: '/r/app',
    })
    expect(native(state(['kotlin'], { jsOnly: true }))[0]).toMatchObject({
      kind: 'skip',
      reason: '--js-only',
    })
    expect(native(state([]))[0]).toMatchObject({ kind: 'skip' })
  })
})

test('replacing the last key keeps the trailing newline and comments after it', () => {
  const text = 'settings:\n  android:\n    versionName: "1.0.0"\n# end\n'
  expect(setModuleVersion(text, 'm', '1.1.0')).toBe(
    'settings:\n  android:\n    versionName: "1.1.0"\n# end\n',
  )
  expect(setModuleVersion('settings:\n  android:\n    versionName: "1"\n', 'm', '2')).toBe(
    'settings:\n  android:\n    versionName: "2"\n',
  )
})

describe('ktlint', () => {
  test('lint and format default to ktlint over Kotlin sources, skipping build output', () => {
    expect(targetCommands('/r', config, 'app', 'lint')).toEqual([
      {
        title: 'ktlint',
        cmd: ['ktlint', '--relative', '**/*.kt', '**/*.kts', '!**/build/**', '!**/node_modules/**'],
        cwd: '/r',
      },
    ])
    expect(targetCommands('/r', config, 'app', 'format')![0]!.cmd.slice(0, 3)).toEqual([
      'ktlint',
      '--relative',
      '-F',
    ])
  })
  test('--staged passes only the staged Kotlin files under the toolchain root', () => {
    const c = configSchema.parse({
      name: 'X',
      toolchain: { root: 'client' },
      targets: { app: { kind: 'kotlin', dir: 'client' } },
    })
    const staged = ['client/shared/src/App.kt', 'client/build.kts', 'README.md', 'other/X.kt']
    expect(targetCommands('/r', c, 'app', 'format', { staged })![0]).toEqual({
      title: 'ktlint -F',
      cmd: ['ktlint', '--relative', '-F', 'shared/src/App.kt', 'build.kts'],
      cwd: '/r/client',
    })
    expect(targetCommands('/r', c, 'app', 'lint', { staged: ['README.md'] })).toBeUndefined()
  })
  test('false turns it off', () => {
    const c = configSchema.parse({
      name: 'X',
      toolchain: { root: '.' },
      targets: { app: { kind: 'kotlin', dir: '.', lint: false } },
    })
    expect(targetCommands('/r', c, 'app', 'lint')).toBeUndefined()
  })
  test('doctor: required, with the version', () => {
    expect(checkKtlint(undefined, true)).toMatchObject({ status: 'fail', detail: 'not found' })
    expect(checkKtlint({ code: 0, output: 'ktlint version 1.8.0\n' }, true)).toMatchObject({
      status: 'ok',
      detail: '1.8.0',
    })
  })
})

test('checkLefthook warns until lefthook and its hook are installed; skipped in CI', () => {
  expect(checkLefthook(undefined, false, undefined, false).status).toBe('skip')
  expect(checkLefthook('lefthook.yml', false, undefined, true).status).toBe('skip')
  expect(checkLefthook('lefthook.yml', false, undefined, false)).toMatchObject({
    status: 'warn',
    detail: 'lefthook not installed',
  })
  expect(checkLefthook('lefthook.yml', true, undefined, false)).toMatchObject({
    status: 'warn',
    hint: 'Run `lefthook install`',
  })
  expect(checkLefthook('lefthook.yml', true, '#!/bin/sh\necho sample', false).status).toBe('warn')
  expect(checkLefthook('lefthook.yml', true, '#!/bin/sh\ncall_lefthook run "pre-commit"', false).status).toBe(
    'ok',
  )
})

test('checkMise warns when mise.toml exists but mise is not installed', () => {
  expect(checkMise({ bun: '1.3.14' }, { bun: '1.3.14' }, false)).toMatchObject({
    status: 'warn',
    detail: 'mise not installed',
  })
  expect(checkMise({ ktlint: '1.8.0' }, { ktlint: '1.7.0' }).detail).toBe('ktlint 1.8.0 (have 1.7.0)')
  expect(checkMise(undefined, {}, false).status).toBe('skip')
})

describe('.kit install dir', () => {
  test('installDir: .kit when .kit/package.json exists, else the root', () => {
    expect(installDir('/r', (p) => p === '/r/.kit/package.json')).toBe('.kit')
    expect(installDir('/r', () => false)).toBe('.')
  })
  test('init installs in .kit and does not report a missing root package.json', () => {
    const s: InitState = {
      root: '/r',
      config,
      exists: (p) => ['.kit/package.json', 'kotlin'].includes(p),
      pm: 'bun',
      accepted: [],
      self: ['kit'],
      exec: (_cwd, bin, ...args) => ['bun', 'x', bin, ...args],
    }
    const plan = planInit(s)
    expect(plan.find((a) => a.title === 'bun install (.kit)')).toMatchObject({
      kind: 'cmd',
      cmd: ['bun', 'install'],
      cwd: '/r/.kit',
    })
    expect(plan.find((a) => a.title === 'install')).toBeUndefined()
  })
})
