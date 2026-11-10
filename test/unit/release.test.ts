import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('checkTools names what an iOS release is missing', async () => {
  const { checkTools } = await import('../../src/lib/release/mobile')
  expect(() => checkTools('ios', (b) => (b === 'bundle' ? '/x' : null))).toThrow(
    'Missing tools for an ios release: xcodebuild, java',
  )
  expect(() => checkTools('android', () => '/x')).not.toThrow()
})

describe('secret checks', () => {
  const full = configSchema.parse({
    name: 'X',
    env: { githubSecrets: ['CLOUDFLARE_API_TOKEN', 'ASC_KEY_ID'] },
    release: {
      ios: {
        bundleIds: ['a'],
        project: 'p',
        scheme: 's',
        output: 'o.ipa',
        sentry: { org: 'o', project: 'p' },
      },
      android: { packageName: 'a', module: ':android' },
    },
  })

  test('releaseSecrets follows the configured platforms', async () => {
    const { releaseSecrets } = await import('../../src/lib/release/creds')
    expect(releaseSecrets(full)).toEqual({
      required: [
        'ASC_KEY_ID',
        'ASC_ISSUER_ID',
        'ASC_KEY_P8_BASE64',
        'MATCH_PASSWORD',
        'MATCH_GIT_URL',
        'ANDROID_KEYSTORE_BASE64',
        'ANDROID_KEYSTORE_ALIAS',
        'ANDROID_KEYSTORE_PASSWORD',
        'PLAY_SERVICE_ACCOUNT_BASE64',
      ],
      ci: ['MATCH_GIT_BASIC_AUTHORIZATION'],
      optional: ['SENTRY_AUTH_TOKEN'],
    })
    expect(releaseSecrets(config)).toEqual({ required: [], ci: [], optional: [] })
  })

  test('doctor: missing release secrets warn (locally and on Actions), hint renames', async () => {
    const { checkReleaseSecrets } = await import('../../src/commands/doctor')
    const { releaseSecrets, renameHints } = await import('../../src/lib/release/creds')
    const env = { APPLE_ASC_KEY_ID: 'x', ASC_ISSUER_ID: 'x' }
    const hints = (m: string[]) => renameHints(m, (old) => old in env)
    const local = checkReleaseSecrets(releaseSecrets(full), env, false, hints)
    expect(local.status).toBe('warn')
    expect(local.detail).toStartWith('missing ASC_KEY_ID, ASC_KEY_P8_BASE64')
    expect(local.detail).not.toContain('MATCH_GIT_BASIC_AUTHORIZATION')
    expect(local.hint).toBe('Rename in .env: APPLE_ASC_KEY_ID → ASC_KEY_ID')
    const ci = checkReleaseSecrets(releaseSecrets(full), env, true, hints)
    expect(ci.status).toBe('warn')
    expect(ci.detail).toContain('MATCH_GIT_BASIC_AUTHORIZATION')
    const all = Object.fromEntries(releaseSecrets(full).required.map((n) => [n, 'v']))
    expect(checkReleaseSecrets(releaseSecrets(full), all, false)).toMatchObject({
      status: 'warn',
      detail: 'all set; optional SENTRY_AUTH_TOKEN unset',
    })
    expect(checkReleaseSecrets(releaseSecrets(config), {}, true).status).toBe('skip')
  })

  test('GitHub: expected = githubSecrets + release secrets; old names reported stale', async () => {
    const { compareGithubSecrets, expectedGithubSecrets } = await import('../../src/lib/env/github')
    const expected = expectedGithubSecrets(full)
    expect(expected.required[0]).toBe('CLOUDFLARE_API_TOKEN')
    expect(expected.required).toContain('MATCH_GIT_BASIC_AUTHORIZATION')
    expect(expected.required.filter((n) => n === 'ASC_KEY_ID')).toHaveLength(1)
    expect(expected.optional).toEqual(['SENTRY_AUTH_TOKEN'])
    const r = compareGithubSecrets(expected, [
      'CLOUDFLARE_API_TOKEN',
      'APPLE_ASC_KEY_ID',
      'FIREBASE_TESTER_GROUP',
    ])
    expect(r.status).toBe('missing')
    expect(r.missing).toContain('ASC_KEY_ID')
    expect(r.optionalMissing).toEqual(['SENTRY_AUTH_TOKEN'])
    expect(r.stale).toEqual(['APPLE_ASC_KEY_ID', 'FIREBASE_TESTER_GROUP'])
    expect(compareGithubSecrets(expected, ['toString', 'constructor']).stale).toEqual([])
  })

  test('GitHub: release secrets are expected only when a workflow releases', async () => {
    const { expectedGithubSecrets, workflowsRelease } = await import('../../src/lib/env/github')
    expect(expectedGithubSecrets(full, false)).toEqual({
      required: ['CLOUDFLARE_API_TOKEN', 'ASC_KEY_ID'],
      optional: [],
    })
    const dir = mkdtempSync(join(tmpdir(), 'kit-wf-'))
    expect(workflowsRelease(dir)).toBe(false)
    const wf = join(dir, '.github', 'workflows')
    mkdirSync(wf, { recursive: true })
    writeFileSync(join(wf, 'lint.yml'), 'run: kit check')
    expect(workflowsRelease(dir)).toBe(false)
    writeFileSync(join(wf, 'ios.yaml'), 'uses: jordond/kit/.github/workflows/mobile-distribute.yml@abc')
    expect(workflowsRelease(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

test('xcconfig MARKETING_VERSION read and rewrite keep the line', async () => {
  const { setXcconfigVersion, xcconfigVersion } = await import('../../src/lib/release/version')
  const text = '// c\nMARKETING_VERSION = 1.2.3 // note\nOTHER = 1\n'
  expect(xcconfigVersion(text)).toBe('1.2.3')
  expect(setXcconfigVersion(text, 'C.xcconfig', '1.3.0')).toBe(
    '// c\nMARKETING_VERSION = 1.3.0 // note\nOTHER = 1\n',
  )
  expect(xcconfigVersion('OTHER = 1')).toBeUndefined()
  expect(() => setXcconfigVersion('OTHER = 1', 'C.xcconfig', '1')).toThrow('has no MARKETING_VERSION line')
  // An empty value must not swallow the next line.
  const empty = 'MARKETING_VERSION =\nCURRENT_PROJECT_VERSION = 1\n'
  expect(xcconfigVersion(empty)).toBeUndefined()
  expect(() => setXcconfigVersion(empty, 'C.xcconfig', '2')).toThrow('has no MARKETING_VERSION line')
  const twice = 'MARKETING_VERSION = 1.0.0\nMARKETING_VERSION = 1.1.0\n'
  expect(() => xcconfigVersion(twice, 'C.xcconfig')).toThrow('sets MARKETING_VERSION 2 times')
  expect(xcconfigVersion('MARKETING_VERSION[config=Debug] = 9\nMARKETING_VERSION = 1.0.0\r\n')).toBe('1.0.0')
})

test('iosVersionDrift: config errors for a missing file or no ios key', async () => {
  const { iosVersionDrift } = await import('../../src/lib/release/version')
  const dir = mkdtempSync(join(tmpdir(), 'kit-xc-'))
  writeFileSync(join(dir, 'v.toml'), '[versions]\napp-ios-version = "1.0.0"\n')
  const ios = { bundleIds: ['a'], project: 'p', scheme: 's', output: 'o.ipa', xcconfig: 'C.xcconfig' }
  const cfg = configSchema.parse({
    name: 'X',
    versions: { file: 'v.toml', keys: { ios: 'app-ios-version' } },
    release: { ios },
  })
  expect(() => iosVersionDrift(dir, cfg)).toThrow('Cannot read release.ios.xcconfig C.xcconfig: ENOENT')
  const noKey = configSchema.parse({
    name: 'X',
    versions: { file: 'v.toml', keys: { api: 'a' } },
    release: { ios },
  })
  expect(() => iosVersionDrift(dir, noKey)).toThrow('versions.keys.ios is not')
  rmSync(dir, { recursive: true, force: true })
})
