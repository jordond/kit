import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KitConfig } from '../../src/config/schema'
import { buildPlan, findArtifact } from '../../src/lib/app/build'
import { androidApp, iosApp } from '../../src/lib/app/config'
import { ExitCode, KitError } from '../../src/lib/errors'

const cfg = (c: unknown) => c as KitConfig
const ios = { bundleId: 'app.example', project: 'client/ios/iosApp.xcodeproj', scheme: 'iosApp' }
const gradle = cfg({
  gradle: { root: 'client' },
  app: { ios, android: { packageName: 'p', module: ':android' } },
})
const toolchain = cfg({
  toolchain: { root: 'tk' },
  app: {
    ios: { ...ios, project: 'tk/iosApp/iosApp.xcodeproj' },
    android: { packageName: 'p', module: 'androidApp' },
  },
})
const exitOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof KitError ? e.exitCode : e
  }
}

describe('app config', () => {
  test('app.* wins, release.* is the fallback', () => {
    const c = cfg({
      release: {
        ios: { bundleIds: ['rel.id'], project: 'a/b.xcodeproj', scheme: 'rel', output: 'x', teamId: 't' },
        android: { packageName: 'rel.pkg', module: ':rel' },
      },
      app: { android: { packageName: 'app.pkg' } },
    })
    expect(iosApp(c)).toMatchObject({ bundleId: 'rel.id', scheme: 'rel', module: 'a' })
    expect(androidApp(c)).toEqual({ packageName: 'app.pkg', module: ':rel' })
  })

  test('a missing key is a config error naming the key', () => {
    expect(exitOf(() => androidApp(cfg({})))).toBe(ExitCode.config)
    expect(exitOf(() => iosApp(cfg({})))).toBe(ExitCode.config)
  })
})

describe('buildPlan', () => {
  test('gradle android: module path maps to the apk dir', () => {
    const plan = buildPlan('/r', gradle, 'android')
    expect(plan.cmd).toEqual(['gradle', ':android:assembleDebug'])
    expect(plan.cwd).toBe('/r/client')
    expect(plan.artifactDir).toBe('/r/client/android/build/outputs/apk/debug')
    const nested = cfg({
      gradle: { root: 'client' },
      app: { android: { packageName: 'p', module: ':apps:android' } },
    })
    const n = buildPlan('/r', nested, 'android', { release: true })
    expect(n.cmd[1]).toBe(':apps:android:assembleRelease')
    expect(n.artifactDir).toBe('/r/client/apps/android/build/outputs/apk/release')
  })

  test('gradle ios: xcodebuild with a destination and derived data beside the project', () => {
    const plan = buildPlan('/r', gradle, 'ios', { device: 'UDID-1' })
    expect(plan.cmd).toEqual([
      'xcodebuild',
      '-project',
      'client/ios/iosApp.xcodeproj',
      '-scheme',
      'iosApp',
      '-configuration',
      'Debug',
      '-destination',
      'platform=iOS Simulator,id=UDID-1',
      '-derivedDataPath',
      '/r/client/ios/build/kit',
      'build',
    ])
    expect(plan.artifactDir).toBe('/r/client/ios/build/kit/Build/Products/Debug-iphonesimulator')
    const any = buildPlan(
      '/r',
      cfg({ gradle: { root: 'client' }, app: { ios: { ...ios, project: 'x/a.xcworkspace' } } }),
      'ios',
    )
    expect(any.cmd.slice(1, 3)).toEqual(['-workspace', 'x/a.xcworkspace'])
    expect(any.cmd).toContain('generic/platform=iOS Simulator')
  })

  test('toolchain android and ios', () => {
    const a = buildPlan('/r', toolchain, 'android')
    expect(a.cmd).toEqual(['./kotlin', 'build', '-m', 'androidApp', '-p', 'android', '-v', 'debug'])
    expect(a.artifactDir).toBe('/r/tk/build/tasks/_androidApp_buildAndroidDebug')
    const i = buildPlan('/r', toolchain, 'ios')
    expect(i.cmd).toEqual(['./kotlin', 'build', '-m', 'iosApp', '-p', 'iosSimulatorArm64', '-v', 'debug'])
    expect(i.artifactDir).toBe(
      '/r/tk/build/tasks/_iosApp_buildIosAppIosSimulatorArm64Debug/bin/Debug-iphonesimulator',
    )
  })

  test('android with neither gradle nor toolchain is a config error', () => {
    const c = cfg({ app: { android: { packageName: 'p', module: ':a' } } })
    expect(exitOf(() => buildPlan('/r', c, 'android'))).toBe(ExitCode.config)
  })
})

describe('findArtifact', () => {
  test('the newest matching entry wins; none is undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-app-unit-'))
    try {
      expect(findArtifact(join(dir, 'missing'), '.apk')).toBeUndefined()
      expect(findArtifact(dir, '.apk')).toBeUndefined()
      writeFileSync(join(dir, 'old.apk'), '')
      writeFileSync(join(dir, 'new.apk'), '')
      writeFileSync(join(dir, 'newest.txt'), '')
      utimesSync(join(dir, 'old.apk'), 1000, 1000)
      utimesSync(join(dir, 'new.apk'), 2000, 2000)
      expect(findArtifact(dir, '.apk')).toBe(join(dir, 'new.apk'))
      mkdirSync(join(dir, 'x.app'))
      expect(findArtifact(dir, '.app')).toBe(join(dir, 'x.app'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('containerEntries', () => {
  const { containerEntries } =
    require('../../src/lib/app/install') as typeof import('../../src/lib/app/install')
  const { mkdirSync, mkdtempSync, realpathSync, writeFileSync } =
    require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const UDID = 'AAAA-1111'

  test('lists the container contents but keeps the container manager metadata', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'kit-container-')))
    const dir = join(base, 'CoreSimulator/Devices', UDID, 'data/Containers/Data/Application/APP-1')
    mkdirSync(join(dir, 'Documents'), { recursive: true })
    writeFileSync(join(dir, '.com.apple.mobile_container_manager.metadata.plist'), '')
    writeFileSync(join(dir, '.hidden'), '')
    expect(containerEntries(dir, UDID).sort()).toEqual(['.hidden', 'Documents'])
  })

  test("refuses a path outside that simulator's app data containers", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'kit-container-')))
    expect(() => containerEntries(base, UDID)).toThrow(/Refusing to clear/)
    const other = join(base, 'CoreSimulator/Devices/OTHER/data/Containers/Data/Application/APP-1')
    mkdirSync(other, { recursive: true })
    expect(() => containerEntries(other, UDID)).toThrow(/Refusing to clear/)
    expect(() => containerEntries('/', UDID)).toThrow(/Refusing to clear/)
  })
})
