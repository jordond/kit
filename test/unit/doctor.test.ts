import { describe, expect, test } from 'bun:test'
import {
  checkAndroidSdk,
  checkCiPin,
  checkEnvFile,
  checkJava,
  checkMise,
  checkRuby,
  checkUnreadable,
  checkWranglerLogin,
  checkXcode,
  parseEnvKeys,
  parseJavaVersion,
  parseMiseTools,
  versionMatches,
} from '../../src/commands/doctor'

const out = (output: string, code = 0) => ({ code, output })

describe('java', () => {
  test.each([
    ['openjdk version "21.0.2" 2024-01-16', '21.0.2'],
    ['java version "1.8.0_292"', '8'],
    ['openjdk version "17" 2021-09-14', '17'],
    ['openjdk 21.0.5 2024-10-15 LTS', '21.0.5'],
  ])('parseJavaVersion(%s) → %s', (s, want) => expect(parseJavaVersion(s)).toBe(want))

  test('21+ passes, older fails when required and warns when not', () => {
    expect(checkJava(out('openjdk version "21.0.2"'), true).status).toBe('ok')
    expect(checkJava(out('openjdk version "25"'), true).status).toBe('ok')
    expect(checkJava(out('openjdk version "17.0.1"'), true)).toMatchObject({
      status: 'fail',
      detail: '17.0.1 (need 21+)',
    })
    expect(checkJava(out('openjdk version "17.0.1"'), false).status).toBe('warn')
  })

  test('missing java', () => {
    expect(checkJava(undefined, true)).toMatchObject({ status: 'fail', detail: 'not found' })
    expect(checkJava(undefined, false).status).toBe('warn')
  })

  test('a probe that exits non-zero (the macOS /usr/bin/java stub) is missing', () => {
    const stub = out('The operation couldn’t be completed. Unable to locate a Java Runtime.', 1)
    expect(checkJava(stub, true)).toMatchObject({ status: 'fail', detail: 'not found' })
    expect(checkJava(stub, false)).toMatchObject({ status: 'warn', detail: 'not found' })
  })
})

describe('unreadable project files', () => {
  test('a parse error is a failed check naming the file', () => {
    expect(checkUnreadable('mise', 'mise.toml versions', 'mise.toml', new Error('bad\nmore'))).toEqual({
      id: 'mise',
      label: 'mise.toml versions',
      status: 'fail',
      detail: 'mise.toml does not parse: bad',
      hint: 'Fix mise.toml',
    })
  })
})

describe('ruby and Xcode', () => {
  test('ruby', () => {
    expect(
      checkRuby(out('ruby 3.3.6 (2024-11-05 revision 75015d4c1f) [arm64-darwin24]'), true),
    ).toMatchObject({
      status: 'ok',
      detail: '3.3.6',
    })
    expect(checkRuby(undefined, true).status).toBe('fail')
  })

  test('Xcode is macOS only', () => {
    expect(checkXcode(undefined, true, 'linux').status).toBe('skip')
    expect(checkXcode(out('Xcode 26.1\nBuild version 17B55'), true, 'darwin')).toMatchObject({
      status: 'ok',
      detail: '26.1',
    })
    expect(checkXcode(out('xcode-select: error', 1), true, 'darwin').status).toBe('fail')
  })
})

describe('Android SDK', () => {
  const yes = () => true
  test('ANDROID_HOME, then ANDROID_SDK_ROOT, then local.properties', () => {
    expect(checkAndroidSdk({ ANDROID_HOME: '/sdk' }, undefined, yes, true).detail).toBe('/sdk')
    expect(checkAndroidSdk({ ANDROID_SDK_ROOT: '/sdk2' }, undefined, yes, true).detail).toBe('/sdk2')
    expect(checkAndroidSdk({}, '# c\nsdk.dir=/Users/me/Android\n', yes, true).detail).toBe(
      '/Users/me/Android',
    )
  })
  test('missing or pointing nowhere', () => {
    expect(checkAndroidSdk({}, undefined, yes, true).status).toBe('fail')
    expect(checkAndroidSdk({}, undefined, yes, false).status).toBe('warn')
    expect(checkAndroidSdk({ ANDROID_HOME: '/nope' }, undefined, () => false, true)).toMatchObject({
      status: 'fail',
      detail: '/nope missing',
    })
  })
})

describe('wrangler login', () => {
  test('skip without a worker, warn when logged out', () => {
    expect(checkWranglerLogin('skip').status).toBe('skip')
    expect(checkWranglerLogin(undefined).status).toBe('warn')
    expect(checkWranglerLogin(out('You are not authenticated. Please run `wrangler login`.')).status).toBe(
      'warn',
    )
    expect(
      checkWranglerLogin(out('You are logged in with an OAuth Token, associated with the email me@x.dev.\n')),
    ).toMatchObject({ status: 'ok', detail: 'me@x.dev' })
  })
})

describe('mise', () => {
  test('parseMiseTools reads strings, arrays and tables', () => {
    expect(
      parseMiseTools({ bun: '1.3', java: ['temurin-21', '17'], ruby: { version: '3.3' }, node: 22 }),
    ).toEqual({
      bun: '1.3',
      java: 'temurin-21',
      ruby: '3.3',
      node: '22',
    })
  })

  test('versionMatches compares the declared components', () => {
    expect(versionMatches('21', '21.0.2')).toBe(true)
    expect(versionMatches('temurin-21', '21.0.2')).toBe(true)
    expect(versionMatches('1.3', '1.3.14')).toBe(true)
    expect(versionMatches('1.3', '1.30.0')).toBe(false)
    expect(versionMatches('latest', '9')).toBe(true)
  })

  test('checkMise lists drift, ignores tools it cannot see', () => {
    expect(checkMise(undefined, {}).status).toBe('skip')
    expect(checkMise({ bun: '1.3', terraform: '1.9' }, { bun: '1.3.14' }).status).toBe('ok')
    expect(checkMise({ bun: '1.2', java: '21' }, { bun: '1.3.14', java: undefined })).toMatchObject({
      status: 'warn',
      detail: 'bun 1.2 (have 1.3.14), java 21 (not found)',
    })
  })
})

describe('.env completeness', () => {
  test('parseEnvKeys', () => {
    expect(parseEnvKeys('# comment\nA=1\nexport B="x"\n  C = \nnot a line\n')).toEqual(['A', 'B', 'C'])
  })

  test('skip, missing file, missing keys, complete', () => {
    expect(checkEnvFile(undefined, 'A=1').status).toBe('skip')
    expect(checkEnvFile('A=', undefined)).toMatchObject({ status: 'fail', hint: 'Run `kit init`' })
    const partial = checkEnvFile('A=\nB=\nC=', 'A=secret-value\n')
    expect(partial).toMatchObject({ status: 'warn', detail: 'missing B, C' })
    expect(JSON.stringify(partial)).not.toContain('secret-value')
    expect(checkEnvFile('A=', 'A=1').status).toBe('ok')
  })
})

describe('CI pin', () => {
  const wf = (v: string) => ({
    file: 'android.yml',
    text: `jobs:\n  ship:\n    uses: jordond/kit/.github/workflows/mobile-distribute.yml@0123abc # v${v}\n`,
  })
  test('matches, drifts, strict', () => {
    expect(checkCiPin([], '^1.2.0', false).status).toBe('skip')
    expect(checkCiPin([wf('1.2.0')], '^1.2.0', false)).toMatchObject({ status: 'ok', detail: '1.2.0' })
    expect(checkCiPin([wf('1.1.0')], '1.2.0', false)).toMatchObject({
      status: 'warn',
      detail: 'android.yml v1.1.0 ≠ package.json 1.2.0',
    })
    expect(checkCiPin([wf('1.1.0')], '1.2.0', true).status).toBe('fail')
  })
})
