import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const SECRETS = {
  ASC_KEY_ID: 'KEYID123',
  ASC_ISSUER_ID: 'issuer-uuid',
  ASC_KEY_P8_BASE64: b64('-----BEGIN PRIVATE KEY-----\nMIGTAgEAsecretbody\n-----END PRIVATE KEY-----\n'),
  MATCH_PASSWORD: 'match-pass-value',
  MATCH_GIT_URL: 'https://github.com/example/certs.git',
  MATCH_GIT_BASIC_AUTHORIZATION: 'basic-auth-value',
  PLAY_SERVICE_ACCOUNT_BASE64: b64('{"type": "service_account", "private_key": "pk-value"}'),
  ANDROID_KEYSTORE_BASE64: b64('keystore-bytes'),
  ANDROID_KEYSTORE_ALIAS: 'upload',
  ANDROID_KEYSTORE_PASSWORD: 'ks-password-value',
}

interface LaneCall {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

let f: Fixture
let remote: string
let laneLog: string

function sh(cmd: string[], cwd = f.dir) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function lanes(): LaneCall[] {
  return readFileSync(laneLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LaneCall)
    .filter((c) => c.argv[0] === 'exec')
}

const run = (args: string[], env: Record<string, string> = {}) =>
  f.kit(args, { env: { ...SECRETS, KIT_TEST_LOG: join(f.dir, '.gradle.log'), ...env } })

beforeEach(() => {
  f = fixture('release', ['bundle'])
  laneLog = join(f.dir, '.lanes.log')
  writeFileSync(laneLog, '')
  // Fake bundle: records argv/cwd/env, answers the lanes the way the shared Fastfile does.
  f.script(
    'bundle',
    `bun -e 'const e=process.env;console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),env:Object.fromEntries(Object.entries(e).filter(([k])=>/^(KIT_|BUNDLE_|FASTLANE_|FL_|ASC_|MATCH_|ANDROID_)/.test(k)))}))' -- "$@" >> "${laneLog}"
case "$*" in
  *"android next_code"*) echo "[10:00:00]: KIT_NEXT_CODE=42" ;;
  *"ios next_build"*) echo "KIT_NEXT_BUILD=7" ;;
  *"android build"*) echo "KIT_ARTIFACT_AAB=/tmp/app.aab" ;;
  *"ios build"*) echo "printing secret $MATCH_PASSWORD"; echo "KIT_ARTIFACT_IPA=/tmp/App.ipa"; echo "KIT_ARTIFACT_DSYM=/tmp/App.dSYM.zip" ;;
esac
exit 0`,
  )
  sh(['git', 'init', '-q', '-b', 'main'])
  sh(['git', 'config', 'user.email', 't@example.com'])
  sh(['git', 'config', 'user.name', 'T'])
  writeFileSync(join(f.dir, '.gitignore'), '.fakebin/\n.calls.log\n.lanes.log\n.gradle.log\nnode_modules/\n')
  sh(['git', 'add', '-A'])
  sh(['git', 'commit', '-qm', 'feat: first'])
  sh(['git', 'commit', '-qm', 'fix: second', '--allow-empty'])
  remote = mkdtempSync(join(tmpdir(), 'kit-remote-'))
  sh(['git', 'init', '-q', '--bare', remote])
  sh(['git', 'remote', 'add', 'origin', remote])
  sh(['git', 'push', '-q', 'origin', 'main'])
})

afterEach(() => {
  f.cleanup()
  rmSync(remote, { recursive: true, force: true })
})

describe('kit release android', () => {
  test('internal: next_code → build → upload_play, then tags and pushes', async () => {
    const r = await run(['release', 'android', '--track', 'internal', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({
      platform: 'android',
      track: 'internal',
      version: '1.4.0',
      build: 42,
      uploaded: true,
      tag: 'android/v1.4.0+42',
      tagPushed: true,
      artifacts: { aab: '/tmp/app.aab' },
    })
    expect(doc.notes).toBe('- fix: second\n- feat: first')
    const calls = lanes()
    expect(calls.map((c) => c.argv.slice(2).join(' '))).toEqual([
      'android next_code',
      'android build',
      'android upload_play',
    ])
    for (const c of calls) {
      expect(c.cwd.replace(/^\/private/, '')).toBe(join(f.dir, 'client').replace(/^\/private/, ''))
      expect(c.env.BUNDLE_GEMFILE).toEndWith('/fastlane/Gemfile')
      expect(c.env.KIT_FASTFILE).toEndWith('/fastlane/Fastfile')
      expect(c.env.BUNDLE_FROZEN).toBe('true')
      expect(c.env.FASTLANE_SKIP_DOCS).toBe('1')
      expect(c.env.KIT_ANDROID_PACKAGE).toBe('app.example')
    }
    const build = calls[1]!.env
    expect(build.KIT_ANDROID_VERSION).toBe('1.4.0')
    expect(build.KIT_ANDROID_CODE).toBe('42')
    expect(build.KIT_ANDROID_KEYSTORE_FILE).toMatch(/release\.keystore$/)
    expect(build.ANDROID_KEYSTORE_PASSWORD).toBe('ks-password-value') // inherited, never argv
    const upload = calls[2]!.env
    expect(upload).toMatchObject({ KIT_PLAY_TRACK: 'internal', KIT_ANDROID_AAB: '/tmp/app.aab' })
    expect(upload.KIT_PLAY_ROLLOUT).toBeUndefined()
    expect(sh(['git', 'ls-remote', '--tags', 'origin'])).toContain('refs/tags/android/v1.4.0+42')
    // secret files are gone after the run
    expect(await Bun.file(build.KIT_ANDROID_KEYSTORE_FILE!).exists()).toBe(false)
    // nothing in the tree changed
    expect(sh(['git', 'status', '--porcelain'])).toBe('')
  })

  test('prod in CI: rollout from flag, gate runs, no prompt', async () => {
    const r = await run(['release', 'android', '-t', 'prod', '--rollout', '0.25', '--code', '100', '--json'])
    expect(r.code).toBe(0)
    const calls = lanes()
    expect(calls.map((c) => c.argv.slice(2).join(' '))).toEqual(['android build', 'android upload_play'])
    expect(calls[1]!.env).toMatchObject({
      KIT_PLAY_TRACK: 'prod',
      KIT_PLAY_ROLLOUT: '0.25',
      KIT_ANDROID_CODE: '100',
    })
    expect(readFileSync(join(f.dir, '.gradle.log'), 'utf8')).toContain(
      'gradlew :android:verifyBaselineProfile',
    )
  })

  test('alpha needs --yes off a terminal', async () => {
    const r = await run(['release', 'android', '--track', 'alpha'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Re-run with --yes')
    expect(lanes().map((c) => c.argv.slice(2).join(' '))).toEqual(['android next_code'])
  })

  test('--dry-run builds but never uploads or tags', async () => {
    const r = await run(['release', 'android', '--track', 'beta', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: true, uploaded: false })
    expect(lanes().map((c) => c.argv.slice(2).join(' '))).toEqual(['android next_code', 'android build'])
    expect(sh(['git', 'tag'])).toBe('')
  })

  test('dirty tree → exit 4 before any lane', async () => {
    writeFileSync(join(f.dir, 'client/gradle/libs.versions.toml'), 'x = 1\n', { flag: 'a' })
    const r = await run(['release', 'android', '--track', 'internal'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('Working tree is not clean')
    expect(lanes()).toEqual([])
  })

  test('disallowed branch → exit 4', async () => {
    sh(['git', 'switch', '-qc', 'feature/x'])
    const r = await run(['release', 'android', '--track', 'internal'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('Releases run from main, release/*')
  })

  test('missing secrets → exit 3 with the canonical names', async () => {
    const r = await run(['release', 'android', '--track', 'internal'], {
      PLAY_SERVICE_ACCOUNT_BASE64: '',
      ANDROID_KEYSTORE_BASE64: '',
    })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('Missing release secrets: PLAY_SERVICE_ACCOUNT_BASE64')
  })

  test('failing preflight → exit 4; --skip bypasses it', async () => {
    const bad = await run(['release', 'android', '--track', 'internal'], { PREFLIGHT_FAIL: '1' })
    expect(bad.code).toBe(4)
    expect(bad.stderr).toContain('demo failed for android internal 1.4.0')
    expect(lanes()).toEqual([])
    const ok = await run(['release', 'android', '--track', 'internal', '--skip', 'demo', '--json'], {
      PREFLIGHT_FAIL: '1',
    })
    expect(ok.code).toBe(0)
  })

  test('a failing upload exits 1 and creates no tag', async () => {
    f.script(
      'bundle',
      'case "$*" in *upload_play*) echo boom; exit 1;; *build*) echo KIT_ARTIFACT_AAB=/tmp/a.aab;; esac; exit 0',
    )
    const r = await run(['release', 'android', '--track', 'internal', '--code', '5'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('boom')
    expect(sh(['git', 'tag'])).toBe('')
  })
})

describe.if(process.platform === 'darwin')('kit release ios', () => {
  test('beta: groups from config, sentry upload, secrets redacted', async () => {
    const r = await run(['release', 'ios', '--track', 'beta', '--yes', '--json', '--verbose'])
    expect(r.code).toBe(0)
    const calls = lanes()
    expect(calls.map((c) => c.argv.slice(2).join(' '))).toEqual([
      'ios next_build',
      'ios build',
      'ios upload_testflight',
      'ios upload_symbols',
    ])
    const [, build, upload, symbols] = calls
    expect(build!.env).toMatchObject({
      KIT_IOS_BUNDLE_IDS: 'app.example,app.example.widget',
      KIT_IOS_BUNDLE_ID: 'app.example',
      KIT_IOS_TEAM_ID: 'TEAM123',
      KIT_IOS_SCHEME: 'iosApp',
      KIT_IOS_VERSION: '1.4.0',
      KIT_IOS_BUILD: '7',
      MATCH_PASSWORD: 'match-pass-value',
    })
    expect(build!.env.KIT_IOS_OUTPUT).toEndWith('/App.ipa')
    expect(build!.env.KIT_ASC_KEY_PATH).toEndWith('asc-key.p8')
    expect(upload!.env).toMatchObject({ KIT_TESTFLIGHT_GROUPS: 'Beta Testers', KIT_IOS_IPA: '/tmp/App.ipa' })
    expect(symbols!.env).toMatchObject({ KIT_IOS_DSYM: '/tmp/App.dSYM.zip', KIT_SENTRY_ORG: 'org' })
    expect(r.stderr).not.toContain('match-pass-value')
    expect(JSON.parse(r.stdout).tag).toBe('ios/v1.4.0+7')
  })

  test('prod needs --notes', async () => {
    const r = await run(['release', 'ios', '--track', 'prod'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--track prod needs --notes')
  })
})

describe('kit version', () => {
  test('show --json', async () => {
    const r = await run(['version', 'show', '--json'])
    expect(r.code).toBe(0)
    expect(
      JSON.parse(r.stdout).versions.map((v: { name: string; version: string }) => [v.name, v.version]),
    ).toEqual([
      ['ios', '1.4.0'],
      ['android', '1.4.0'],
      ['api', '2.0.1'],
    ])
  })

  test('bump minor (all) edits only the version values, commits and pushes', async () => {
    const before = readFileSync(join(f.dir, 'client/gradle/libs.versions.toml'), 'utf8')
    const r = await run(['version', 'bump', 'minor', '--yes', '--json'])
    expect(r.code).toBe(0)
    const after = readFileSync(join(f.dir, 'client/gradle/libs.versions.toml'), 'utf8')
    expect(after).toBe(
      before
        .replace('app-ios-version = "1.4.0"', 'app-ios-version = "1.5.0"')
        .replace('app-android-version = "1.4.0"', 'app-android-version = "1.5.0"'),
    )
    expect(sh(['git', 'log', '-1', '--format=%s'])).toBe('chore(release): ios 1.5.0, android 1.5.0')
    expect(JSON.parse(r.stdout)).toMatchObject({ pushed: true, branch: 'main' })
    expect(sh(['git', 'rev-parse', 'origin/main'])).toBe(sh(['git', 'rev-parse', 'HEAD']))
  })

  test('bump patch --platform api --no-push keeps single quotes', async () => {
    const r = await run(['version', 'bump', 'patch', '--platform', 'api', '--no-push'])
    expect(r.code).toBe(0)
    expect(readFileSync(join(f.dir, 'client/gradle/libs.versions.toml'), 'utf8')).toContain(
      "api-version = '2.0.2'",
    )
    expect(sh(['git', 'rev-parse', 'origin/main'])).not.toBe(sh(['git', 'rev-parse', 'HEAD']))
  })

  test('bump --dry-run changes nothing', async () => {
    const r = await run(['version', 'bump', 'major', '--platform', 'ios', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).changes).toEqual([{ name: 'ios', from: '1.4.0', to: '2.0.0' }])
    expect(sh(['git', 'status', '--porcelain'])).toBe('')
  })

  test('bad level → exit 2; unknown platform → exit 2', async () => {
    expect((await run(['version', 'bump', 'huge'])).code).toBe(2)
    const r = await run(['version', 'bump', 'patch', '--platform', 'web'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Known: ios, android, api')
  })
})

describe('kit release <service>', () => {
  test('builds, deploys, tags api/v<version>', async () => {
    const r = await run(['release', 'api', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({
      service: 'api',
      version: '2.0.1',
      tag: 'api/v2.0.1',
      tagPushed: true,
    })
    const again = await run(['release', 'api', '--yes'])
    expect(again.code).toBe(4)
    expect(again.stderr).toContain('kit version bump patch --platform api')
  })

  test('shows in help', async () => {
    const r = await run(['release', '--help'])
    expect(r.stdout + r.stderr).toContain('api')
  })
})

describe('kit fastlane', () => {
  test('passes args through with the kit env and the key files', async () => {
    const r = await run(['fastlane', 'lanes', '--json'])
    expect(r.code).toBe(0)
    const [call] = lanes()
    expect(call!.argv).toEqual(['exec', 'fastlane', 'lanes', '--json'])
    expect(call!.env.KIT_ASC_KEY_PATH).toEndWith('asc-key.p8')
    expect(call!.env.KIT_PLAY_JSON_KEY).toEndWith('play.json')
    expect(call!.env.FL_REPORT_PATH).toContain('kit-fastlane-')
  })

  test('-h prints kit usage without running fastlane', async () => {
    const r = await run(['fastlane', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Usage: kit fastlane')
    expect(lanes()).toEqual([])
  })
})
