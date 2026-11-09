import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { parseOutputs } from '../../src/lib/fastlane'
import { clampNotes, mobileTag, releaseNotes, serviceTag } from '../../src/lib/release/notes'
import { compareVersions, expandPlatforms, nextVersion, setVersion } from '../../src/lib/release/version'

const config = configSchema.parse({
  name: 'X',
  versions: { file: 'v.toml', keys: { ios: 'app-ios-version', android: 'app-android-version', api: 'api' } },
})

describe('versions', () => {
  test('nextVersion', () => {
    expect(nextVersion('1.4.9', 'patch')).toBe('1.4.10')
    expect(nextVersion('1.4.9', 'minor')).toBe('1.5.0')
    expect(nextVersion('1.4.9', 'major')).toBe('2.0.0')
    expect(() => nextVersion('1.4', 'patch')).toThrow('not a MAJOR.MINOR.PATCH')
  })
  test('compareVersions', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })
  test('setVersion edits only the value', () => {
    const text =
      '[versions]\napp-ios-version = "1.0.0" # ios\napi = \'3.1.0\'\n[libraries]\napp-ios-version = "x"\n'
    expect(setVersion(text, config, 'ios', '1.1.0')).toBe(text.replace('"1.0.0"', '"1.1.0"'))
    expect(setVersion(text, config, 'api', '3.2.0')).toContain("api = '3.2.0'")
  })
  test('expandPlatforms', () => {
    expect(expandPlatforms(config, 'all')).toEqual(['ios', 'android'])
    expect(expandPlatforms(config, 'api')).toEqual(['api'])
    expect(() => expandPlatforms(config, 'web')).toThrow('No version key for "web"')
  })
})

describe('notes and tags', () => {
  test('tags', () => {
    expect(mobileTag('ios', '1.4.0', 12)).toBe('ios/v1.4.0+12')
    expect(serviceTag('api', '2.0.0')).toBe('api/v2.0.0')
  })
  test('clampNotes keeps whole lines', () => {
    expect(clampNotes('- a\n- b\n- c', 7)).toBe('- a\n- b')
    expect(clampNotes('abcdefghij', 5)).toBe('abcd…')
    expect(clampNotes('short', 500)).toBe('short')
  })
  test('releaseNotes: since the platform tag, else the last 20', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-notes-'))
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@e.com')
    git('config', 'user.name', 'T')
    for (let i = 1; i <= 25; i++) git('commit', '-qm', `c${i}`, '--allow-empty')
    const none = await releaseNotes('ios', dir)
    expect(none.since).toBeUndefined()
    expect(none.notes.split('\n')).toHaveLength(20)
    expect(none.notes.split('\n')[0]).toBe('- c25')
    git('tag', 'ios/v1.0.0+3', 'HEAD~2')
    git('tag', 'android/v1.0.0+9', 'HEAD~1')
    const ios = await releaseNotes('ios', dir)
    expect(ios).toEqual({ since: 'ios/v1.0.0+3', notes: '- c25\n- c24' })
    expect((await releaseNotes('android', dir)).notes).toBe('- c25')
    rmSync(dir, { recursive: true, force: true })
  })
})

test('parseOutputs accepts the fastlane timestamp prefix and ignores noise', () => {
  expect(
    parseOutputs(
      '[12:00:01]: KIT_NEXT_BUILD=8\nnoise KIT_X=1\nKIT_ARTIFACT_IPA=/a b/App.ipa\n\x1b[32mKIT_C=3\x1b[0m',
    ),
  ).toEqual({ NEXT_BUILD: '8', ARTIFACT_IPA: '/a b/App.ipa', C: '3' })
})
