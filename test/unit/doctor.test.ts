import { describe, expect, test } from 'bun:test'
import {
  CATALOG_KEYS,
  catalogPath,
  checkAdb,
  checkAndroidSdk,
  checkCatalogKeys,
  checkChrome,
  checkCiPin,
  checkEmulator,
  checkEnvFile,
  checkJava,
  checkMaestro,
  checkMaestroJava,
  checkMise,
  checkRuby,
  checkSimulator,
  checkUnreadable,
  checkWranglerLogin,
  checkXcode,
  parseChromeVersion,
  parseEnvKeys,
  parseJavaVersion,
  parseMiseTools,
  versionMatches,
} from '../../src/commands/doctor'
import type { KitConfig } from '../../src/config/schema'
import { CHROME_HINT, CHROME_MIN_MAJOR } from '../../src/lib/chrome'

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

describe('catalog keys (§13.5)', () => {
  const full = { versions: Object.fromEntries(CATALOG_KEYS.map((k) => [k, '1'])) }
  const cfg = (extra: object = {}) =>
    ({ name: 'x', targets: {}, gradle: { root: 'apps/client' }, ...extra }) as unknown as KitConfig

  test('path: versions.file, else <gradle root>/gradle/libs.versions.toml; none without a gradle root', () => {
    expect(catalogPath(cfg())).toBe('apps/client/gradle/libs.versions.toml')
    expect(catalogPath(cfg({ versions: { file: 'gradle/libs.versions.toml', keys: {} } }))).toBe(
      'gradle/libs.versions.toml',
    )
    expect(catalogPath({ name: 'x', targets: {} } as unknown as KitConfig)).toBeUndefined()
  })

  test('skip without a gradle root, ok with every key', () => {
    expect(checkCatalogKeys(undefined, undefined).status).toBe('skip')
    expect(checkCatalogKeys('c.toml', full)).toMatchObject({ status: 'ok', detail: 'c.toml' })
  })

  test('missing keys fail, named with a hint', () => {
    const { 'app-jvm-target': _jvm, 'app-ios-version': _ios, ...rest } = full.versions
    expect(checkCatalogKeys('c.toml', { versions: rest })).toMatchObject({
      id: 'catalog',
      status: 'fail',
      detail: 'c.toml [versions] missing app-jvm-target, app-ios-version',
      hint: "Add them under [versions] in c.toml; kit's Gradle plugins read them",
    })
    expect(checkCatalogKeys('c.toml', {}).detail).toContain(CATALOG_KEYS.join(', '))
  })

  test('a missing catalog fails', () => {
    expect(checkCatalogKeys('c.toml', undefined)).toMatchObject({ status: 'fail', detail: 'c.toml missing' })
  })
})

describe('devices', () => {
  test('adb: found is ok; missing only warns', () => {
    expect(checkAdb('/sdk/platform-tools/adb')).toMatchObject({
      status: 'ok',
      detail: '/sdk/platform-tools/adb',
    })
    expect(checkAdb(undefined)).toMatchObject({ id: 'adb', status: 'warn' })
  })

  test('emulator: names each missing piece and the sdkmanager packages', () => {
    const image = 'system-images;android-36;google_apis;arm64-v8a'
    expect(checkEmulator({ emulator: true, avdmanager: true, image, abi: 'arm64-v8a' })).toMatchObject({
      status: 'ok',
      detail: image,
    })
    const c = checkEmulator({ emulator: true, avdmanager: false, image: undefined, abi: 'x86_64' })
    expect(c.status).toBe('warn')
    expect(c.detail).toBe('missing cmdline-tools (avdmanager), a x86_64 system image')
    expect(c.hint).toContain('"cmdline-tools;latest" "system-images;android-36;google_apis_playstore;x86_64"')
    expect(c.hint).not.toContain('sdkmanager emulator')
  })

  test('simulator: newest available iOS runtime; none warns; skipped off macOS', () => {
    const runtimes = (list: object[]) => ({ code: 0, output: JSON.stringify({ runtimes: list }) })
    const ios = (version: string, isAvailable = true) => ({
      identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace('.', '-')}`,
      version,
      isAvailable,
    })
    expect(checkSimulator(runtimes([ios('18.6'), ios('26.1'), ios('27.0', false)]), 'darwin')).toMatchObject({
      status: 'ok',
      detail: 'iOS 26.1',
    })
    const watch = { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0', version: '26.0' }
    expect(checkSimulator(runtimes([watch]), 'darwin')).toMatchObject({
      status: 'warn',
      detail: 'no iOS runtime installed',
    })
    expect(checkSimulator({ code: 0, output: 'not json' }, 'darwin').status).toBe('warn')
    expect(checkSimulator(undefined, 'darwin').status).toBe('warn')
    expect(checkSimulator(undefined, 'linux').status).toBe('skip')
  })
})

describe('chrome', () => {
  test.each([
    ['Google Chrome 131.0.6778.86 \n', '131.0.6778.86'],
    ['Chromium 120.0.6099.109 built on Debian 12.4, running on Debian 12.4\n', '120.0.6099.109'],
    ['Google Chrome for Testing 112.0.5615.49', '112.0.5615.49'],
    ['[0412/101500.123:WARNING:x.cc(42)] 9.8.7\nGoogle Chrome 131.0.6778.86\n', '131.0.6778.86'],
    ['no version here', undefined],
  ])('parseChromeVersion(%s) → %s', (s, want) => expect(parseChromeVersion(s)).toBe(want))

  test('not installed warns with the install hint', () => {
    expect(checkChrome(undefined)).toEqual({
      id: 'chrome',
      label: 'chrome',
      status: 'warn',
      detail: 'not found',
      hint: CHROME_HINT,
    })
  })

  test('older than the minimum major warns; the minimum and newer pass with the version', () => {
    expect(CHROME_MIN_MAJOR).toBe(112)
    const old = checkChrome(out('Google Chrome 111.0.5563.146\n'))
    expect(old).toMatchObject({ status: 'warn', detail: '111.0.5563.146 (need 112+)' })
    expect(old.hint).toContain('KIT_CHROME')
    expect(checkChrome(out('Google Chrome 112.0.5615.49\n'))).toEqual({
      id: 'chrome',
      label: 'chrome',
      status: 'ok',
      detail: '112.0.5615.49',
    })
    expect(checkChrome(out('Chromium 131.0.6778.86 built on Debian\n'))).toMatchObject({
      status: 'ok',
      detail: '131.0.6778.86',
    })
  })

  test('a binary that fails or prints no version warns, never fails', () => {
    expect(checkChrome(out('', 1))).toMatchObject({ status: 'warn', detail: 'unknown version' })
    expect(checkChrome(out('hello\n'))).toMatchObject({ status: 'warn', detail: 'unknown version' })
  })
})

describe('maestro', () => {
  test('not installed warns with the install hint, pinned version included', () => {
    expect(checkMaestro(undefined, undefined)).toMatchObject({
      id: 'maestro',
      status: 'warn',
      detail: 'not found',
      hint: 'curl -Ls https://get.maestro.mobile.dev | bash',
    })
    expect(checkMaestro(undefined, '2.9.0').hint).toBe(
      'MAESTRO_VERSION=2.9.0 curl -Ls https://get.maestro.mobile.dev | bash',
    )
  })

  test('a version that differs from the pin warns; a match or no pin is ok', () => {
    expect(checkMaestro(out('2.9.0\n'), '2.12.1')).toMatchObject({
      status: 'warn',
      detail: '2.9.0 (config pins 2.12.1)',
    })
    expect(checkMaestro(out('2.9.0\n'), '2.9.0')).toMatchObject({ status: 'ok', detail: '2.9.0' })
    expect(checkMaestro(out('2.9.0\n'), undefined)).toMatchObject({ status: 'ok', detail: '2.9.0' })
  })

  test('extra output lines around the version are tolerated', () => {
    expect(checkMaestro(out('Picked up JAVA_TOOL_OPTIONS: -Xmx1g\n2.9.0\n'), undefined).detail).toBe('2.9.0')
  })

  test('maestro needs java 17+: warns when missing or older, unless the java check already fails', () => {
    const javaOk = checkJava(out('openjdk version "21.0.2"'), false)
    expect(
      checkMaestroJava(out('openjdk version "17.0.1"'), checkJava(out('openjdk version "17.0.1"'), false)),
    ).toMatchObject({
      id: 'maestro-java',
      status: 'ok',
    })
    expect(checkMaestroJava(out('openjdk version "11.0.2"'), javaOk)).toMatchObject({
      status: 'warn',
      detail: '11.0.2 (need 17+)',
    })
    expect(checkMaestroJava(undefined, checkJava(undefined, false))).toMatchObject({
      status: 'warn',
      detail: 'not found',
    })
    expect(checkMaestroJava(undefined, checkJava(undefined, true))).toBeUndefined()
  })
})
