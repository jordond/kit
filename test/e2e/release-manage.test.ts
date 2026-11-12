import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

// kit release status | promote | rollout: every store call is the recording fake `bundle`.

const b64 = (s: string) => Buffer.from(s).toString('base64')
const SECRETS = {
  ASC_KEY_ID: 'KEYID123',
  ASC_ISSUER_ID: 'issuer-uuid',
  ASC_KEY_P8_BASE64: b64('-----BEGIN PRIVATE KEY-----\nMIGTAgEAsecretbody\n-----END PRIVATE KEY-----\n'),
  PLAY_SERVICE_ACCOUNT_BASE64: b64('{"type": "service_account", "private_key": "pk-value"}'),
  // No match or keystore secrets: nothing here signs or builds.
  MATCH_PASSWORD: '',
  MATCH_GIT_URL: '',
  ANDROID_KEYSTORE_BASE64: '',
  ANDROID_KEYSTORE_ALIAS: '',
  ANDROID_KEYSTORE_PASSWORD: '',
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

const names = () => lanes().map((c) => c.argv.slice(2).join(' '))

const run = (args: string[], env: Record<string, string> = {}) =>
  f.kit(args, {
    env: { ...SECRETS, GITHUB_ACTIONS: '', KIT_TEST_LOG: join(f.dir, '.gradle.log'), ...env },
  })

const record = () =>
  `bun -e 'const e=process.env;console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),env:Object.fromEntries(Object.entries(e).filter(([k])=>/^(KIT_|BUNDLE_|FASTLANE_|FL_|ASC_|MATCH_|ANDROID_)/.test(k)))}))' -- "$@" >> "${laneLog}"`

/** Fake bundle: records argv/cwd/env, answers the lanes the way the shared Fastfile does. */
function fakeBundle(cases: string) {
  f.script('bundle', `${record()}\ncase "$*" in\n${cases}\nesac\nexit 0`)
}

const ANSWERS = `  *"android status"*)
    echo "[10:00:00]: KIT_STATUS_INTERNAL_CODES=41,42"
    echo 'KIT_STATUS_INTERNAL_NAMES=["1.4.0"]'
    echo "KIT_STATUS_ALPHA_CODES=40"
    echo "KIT_STATUS_BETA_ERROR=Google Api Error: forbidden"
    echo "KIT_STATUS_PRODUCTION_CODES=" ;;
  *"ios status"*)
    echo "KIT_STATUS_TESTFLIGHT_BUILD=7"; echo "KIT_STATUS_TESTFLIGHT_VERSION=1.4.0"
    echo "KIT_STATUS_APPSTORE_BUILD=5"; echo "KIT_STATUS_APPSTORE_VERSION=1.3.0"
    echo "KIT_STATUS_APPSTORE_PHASED=ACTIVE" ;;
  *"android rollout"*) echo "KIT_ROLLOUT_STATE=inProgress"; echo "KIT_ROLLOUT_FRACTION=0.25"; echo "KIT_ROLLOUT_CODE=\${KIT_ANDROID_CODE:-40}" ;;
  *"ios promote_build"*) echo "KIT_PROMOTE_BUILD=7" ;;
  *"ios rollout"*) echo "KIT_ROLLOUT_VERSION=1.3.0"; echo "KIT_ROLLOUT_STATE=PAUSED" ;;`

beforeEach(() => {
  f = fixture('release', ['bundle'])
  laneLog = join(f.dir, '.lanes.log')
  writeFileSync(laneLog, '')
  fakeBundle(ANSWERS)
  sh(['git', 'init', '-q', '-b', 'main'])
  sh(['git', 'config', 'user.email', 't@example.com'])
  sh(['git', 'config', 'user.name', 'T'])
  writeFileSync(join(f.dir, '.gitignore'), '.fakebin/\n.calls.log\n.lanes.log\n.gradle.log\nnode_modules/\n')
  sh(['git', 'add', '-A'])
  sh(['git', 'commit', '-qm', 'feat: first'])
  remote = mkdtempSync(join(tmpdir(), 'kit-remote-'))
  sh(['git', 'init', '-q', '--bare', remote])
  sh(['git', 'remote', 'add', 'origin', remote])
  sh(['git', 'push', '-q', 'origin', 'main'])
})

afterEach(() => {
  f.cleanup()
  rmSync(remote, { recursive: true, force: true })
})

describe('kit release status', () => {
  test('--json: every configured platform, one document, an unreadable track is unknown', async () => {
    const r = await run(['release', 'status', '--json'])
    expect(r.code).toBe(0)
    expect(names()).toEqual(['ios status', 'android status'])
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      platforms: [
        {
          platform: 'ios',
          version: '1.4.0',
          ok: true,
          tracks: [
            { track: 'testflight', state: 'ok', build: 7, version: '1.4.0' },
            { track: 'prod', state: 'ok', build: 5, version: '1.3.0', phased: 'ACTIVE' },
          ],
        },
        {
          platform: 'android',
          version: '1.4.0',
          ok: true,
          tracks: [
            { track: 'internal', state: 'ok', build: 42, codes: [41, 42], names: ['1.4.0'] },
            { track: 'alpha', state: 'ok', build: 40, codes: [40] },
            { track: 'beta', state: 'unknown', build: null, error: 'Google Api Error: forbidden' },
            { track: 'prod', state: 'empty', build: null, codes: [] },
          ],
        },
      ],
    })
    expect(r.stderr).toContain('android beta: unknown (Google Api Error: forbidden)')
    const [ios, android] = lanes()
    expect(ios!.env.KIT_ASC_KEY_PATH).toEndWith('asc-key.p8')
    expect(ios!.env.KIT_IOS_BUNDLE_ID).toBe('app.example')
    expect(android!.env.KIT_PLAY_JSON_KEY).toEndWith('play.json')
    expect(android!.env.KIT_ANDROID_PACKAGE).toBe('app.example')
    expect(android!.env.KIT_ANDROID_KEYSTORE_FILE).toBeUndefined()
    expect(android!.cwd.replace(/^\/private/, '')).toBe(join(f.dir, 'client').replace(/^\/private/, ''))
  })

  test('one platform: the table goes to stdout, logs to stderr', async () => {
    const r = await run(['release', 'status', 'android'])
    expect(r.code).toBe(0)
    expect(names()).toEqual(['android status'])
    const out = r.stdout.split('\n').map((l) => l.trimEnd())
    expect(out[0]).toBe('android 1.4.0')
    expect(out[1]).toBe('  internal   42  1.4.0 · codes 41, 42')
    expect(out[2]).toBe('  alpha      40')
    expect(out[3]).toBe('  beta       unknown (Google Api Error: forbidden)')
    expect(out[4]).toBe('  prod       no build')
  })

  test('ios: a phased release that could not be read is unknown, with the reason', async () => {
    fakeBundle(`  *"ios status"*)
    echo "KIT_STATUS_TESTFLIGHT_BUILD=7"; echo "KIT_STATUS_TESTFLIGHT_VERSION=1.4.0"
    echo "KIT_STATUS_APPSTORE_BUILD=5"; echo "KIT_STATUS_APPSTORE_VERSION=1.3.0"
    echo "KIT_STATUS_APPSTORE_PHASED_ERROR=Authentication credentials are missing or invalid" ;;`)
    const r = await run(['release', 'status', 'ios', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).platforms[0].tracks[1]).toEqual({
      track: 'prod',
      state: 'ok',
      build: 5,
      version: '1.3.0',
      phased: 'unknown',
      phasedError: 'Authentication credentials are missing or invalid',
    })
    expect(r.stderr).toContain(
      'ios prod: phased release unknown (Authentication credentials are missing or invalid)',
    )
    const human = await run(['release', 'status', 'ios'])
    expect(human.stdout).toContain('phased unknown (Authentication credentials are missing or invalid)')
  })

  test('every track unreadable → exit 1, still one JSON document', async () => {
    fakeBundle(`  *"android status"*)
    for t in INTERNAL ALPHA BETA PRODUCTION; do echo "KIT_STATUS_\${t}_ERROR=no access"; done ;;`)
    const r = await run(['release', 'status', 'android', '--json'])
    expect(r.code).toBe(1)
    const doc = JSON.parse(r.stdout)
    expect(doc.ok).toBe(false)
    expect(doc.platforms[0].tracks.map((t: { state: string }) => t.state)).toEqual(Array(4).fill('unknown'))
    expect(r.stderr).toContain('No track could be read for android')
  })

  test('a failing lane → exit 1; an unknown platform → exit 2', async () => {
    fakeBundle('  *"ios status"*) echo "bad key"; exit 1 ;;')
    const r = await run(['release', 'status', 'ios', '--json'])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, platforms: [{ platform: 'ios', ok: false }] })
    const bad = await run(['release', 'status', 'web'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('ios or android (got "web")')
  })
})

describe('kit release promote', () => {
  test('--from internal is refused with the reason, before anything runs', async () => {
    const r = await run(['release', 'promote', 'android', '--from', 'internal', '--to', 'beta', '--yes'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Internal builds are never promoted')
    expect(r.stderr).toContain('KIT_INTERNAL')
    expect(r.stderr).toContain('kit release <platform> --track beta')
    expect(lanes()).toEqual([])
    const json = await run(['release', 'promote', 'ios', '--from', 'internal', '--to', 'prod', '--json'])
    expect(json.code).toBe(2)
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, exitCode: 2 })
  })

  test('--to must be later than --from; a platform is required', async () => {
    const r = await run(['release', 'promote', 'android', '--from', 'beta', '--to', 'beta'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--to must be a later track than --from')
    const none = await run(['release', 'promote', '--from', 'alpha', '--to', 'beta'])
    expect(none.code).toBe(2)
    expect(none.stderr).toContain('needs a platform: ios or android')
    expect(lanes()).toEqual([])
  })

  test('android alpha → beta: latest code on alpha, promote lane, nothing built, no tag made', async () => {
    const r = await run([
      'release',
      'promote',
      'android',
      '--from',
      'alpha',
      '--to',
      'beta',
      '--yes',
      '--json',
    ])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      platform: 'android',
      from: 'alpha',
      to: 'beta',
      version: '1.4.0',
      build: 40,
      dryRun: false,
      promoted: true,
      tag: 'android/v1.4.0+40',
      tagExisted: false,
      tagCommand:
        'git tag -a android/v1.4.0+40 -m "android 1.4.0 (40)" <commit> && git push origin android/v1.4.0+40',
    })
    expect(JSON.parse(r.stdout).tagPushed).toBeUndefined()
    // HEAD did not build this build: kit warns and leaves the tag to the user.
    expect(r.stderr).toContain('there is no android/v1.4.0+40 tag, and kit does not create it here')
    expect(sh(['git', 'tag'])).toBe('')
    expect(sh(['git', 'ls-remote', '--tags', 'origin'])).toBe('')
    expect(names()).toEqual(['android status', 'android promote'])
    const [status, promote] = lanes()
    expect(status!.env.KIT_STATUS_TRACKS).toBe('alpha')
    expect(promote!.env).toMatchObject({
      KIT_PLAY_TRACK: 'alpha',
      KIT_PLAY_PROMOTE_TO: 'beta',
      KIT_ANDROID_CODE: '40',
      KIT_ANDROID_PACKAGE: 'app.example',
    })
    expect(promote!.env.KIT_PLAY_JSON_KEY).toEndWith('play.json')
    expect(promote!.env.KIT_PLAY_ROLLOUT).toBeUndefined()
    expect(promote!.env.KIT_PLAY_DRAFT).toBe('0')
    expect(promote!.env.KIT_RELEASE_NOTES).toBeUndefined()
    expect(promote!.env.KIT_INTERNAL).toBeUndefined()
    expect(promote!.env.KIT_ANDROID_KEYSTORE_FILE).toBeUndefined()
    expect(promote!.cwd.replace(/^\/private/, '')).toBe(join(f.dir, 'client').replace(/^\/private/, ''))
    // no build, so no gate task either
    expect(existsSync(join(f.dir, '.gradle.log'))).toBe(false)
  })

  test('android beta → prod on GitHub Actions: --build, --rollout, no store lookup', async () => {
    const r = await run(
      [
        'release',
        'promote',
        'android',
        '--from',
        'beta',
        '--to',
        'prod',
        '--build',
        '100',
        '--rollout',
        '0.25',
        '--json',
      ],
      { GITHUB_ACTIONS: 'true' },
    )
    expect(r.code).toBe(0)
    expect(names()).toEqual(['android promote'])
    expect(lanes()[0]!.env).toMatchObject({
      KIT_PLAY_TRACK: 'beta',
      KIT_PLAY_PROMOTE_TO: 'prod',
      KIT_ANDROID_CODE: '100',
      KIT_PLAY_ROLLOUT: '0.25',
    })
    expect(JSON.parse(r.stdout)).toMatchObject({ build: 100, tag: 'android/v1.4.0+100' })
  })

  test('android: --draft drops the rollout; notes are clamped onto a testing track', async () => {
    const r = await run([
      'release',
      'promote',
      'android',
      '--from',
      'alpha',
      '--to',
      'beta',
      '--build',
      '9',
      '--draft',
      '--notes',
      'Fixes',
      '--yes',
    ])
    expect(r.code).toBe(0)
    expect(lanes()[0]!.env).toMatchObject({ KIT_PLAY_DRAFT: '1', KIT_RELEASE_NOTES: 'Fixes' })
    expect(lanes()[0]!.env.KIT_PLAY_ROLLOUT).toBeUndefined()
  })

  test('prod off GitHub Actions needs a typed "prod", --yes or not', async () => {
    const r = await run([
      'release',
      'promote',
      'android',
      '--from',
      'beta',
      '--to',
      'prod',
      '--build',
      '100',
      '--yes',
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Production releases need a terminal')
    expect(lanes()).toEqual([])
    expect(sh(['git', 'tag'])).toBe('')
  })

  test('beta needs --yes off a terminal', async () => {
    const r = await run(['release', 'promote', 'android', '--from', 'alpha', '--to', 'beta', '--build', '40'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Re-run with --yes')
    expect(lanes()).toEqual([])
  })

  test('a build tagged at its first release keeps that tag', async () => {
    sh(['git', 'tag', 'android/v1.4.0+40'])
    const r = await run([
      'release',
      'promote',
      'android',
      '--from',
      'alpha',
      '--to',
      'beta',
      '--yes',
      '--json',
    ])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ promoted: true, tag: 'android/v1.4.0+40', tagExisted: true })
    expect(doc.tagPushed).toBeUndefined()
    expect(doc.tagCommand).toBeUndefined()
    expect(r.stderr).not.toContain('kit does not create it')
  })

  test('--dry-run prints the plan and runs nothing', async () => {
    const r = await run([
      'release',
      'promote',
      'android',
      '--from',
      'alpha',
      '--to',
      'prod',
      '--dry-run',
      '--json',
    ])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      platform: 'android',
      from: 'alpha',
      to: 'prod',
      version: '1.4.0',
      build: null,
      dryRun: true,
      promoted: false,
      plan: ['fastlane android status', 'fastlane android promote'],
    })
    expect(lanes()).toEqual([])
    expect(sh(['git', 'tag'])).toBe('')
    const human = await run([
      'release',
      'promote',
      'ios',
      '--from',
      'beta',
      '--to',
      'prod',
      '--build',
      '7',
      '-n',
    ])
    expect(human.code).toBe(0)
    expect(human.stdout).toBe('')
    expect(human.stderr).toContain('App ios 1.4.0 (7): beta → App Store (phased, manual release)')
    expect(human.stderr).toContain('fastlane ios promote_appstore')
    expect(lanes()).toEqual([])
  })

  test('gates: branch → 4, secrets → 3, preflight → 4 (--skip bypasses), empty track → 4', async () => {
    const args = ['release', 'promote', 'android', '--from', 'alpha', '--to', 'beta', '--yes']
    const pre = await run(args, { PREFLIGHT_FAIL: '1' })
    expect(pre.code).toBe(4)
    expect(pre.stderr).toContain('demo failed for android beta 1.4.0')
    expect(lanes()).toEqual([])
    expect((await run([...args, '--skip', 'demo', '--build', '40'], { PREFLIGHT_FAIL: '1' })).code).toBe(0)

    const secrets = await run(args, { PLAY_SERVICE_ACCOUNT_BASE64: '' })
    expect(secrets.code).toBe(3)
    expect(secrets.stderr).toContain('Missing release secrets: PLAY_SERVICE_ACCOUNT_BASE64')

    const empty = await run(['release', 'promote', 'android', '--from', 'beta', '--to', 'prod', '--yes'])
    // beta could not be read (KIT_STATUS_BETA_ERROR): that is not "no release"
    expect(empty.code).toBe(4)
    expect(empty.stderr).toContain('Could not read the Play beta track: Google Api Error: forbidden')
    expect(empty.stderr).not.toContain('No release on the Play beta track')

    sh(['git', 'switch', '-qc', 'feature/x'])
    const branch = await run(args)
    expect(branch.code).toBe(4)
    expect(branch.stderr).toContain('Releases run from main, release/*')
  })

  test('a failing promote lane exits 1 and creates no tag', async () => {
    fakeBundle('  *"android promote"*) echo boom; exit 1 ;;')
    const r = await run([
      'release',
      'promote',
      'android',
      '--from',
      'alpha',
      '--to',
      'beta',
      '--build',
      '5',
      '--yes',
      '--json',
    ])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, promoted: false, build: 5 })
    expect(sh(['git', 'tag'])).toBe('')
  })

  test('usage: --rollout and --draft are Android-only, --rollout is prod-only', async () => {
    const a = await run([
      'release',
      'promote',
      'android',
      '--from',
      'alpha',
      '--to',
      'beta',
      '--rollout',
      '0.5',
      '--yes',
    ])
    expect(a.code).toBe(2)
    expect(a.stderr).toContain('--rollout applies to Android production only')
    const b = await run(['release', 'promote', 'ios', '--from', 'alpha', '--to', 'beta', '--draft', '--yes'])
    expect(b.code).toBe(2)
    expect(lanes()).toEqual([])
  })

  test('ios alpha → beta: the build comes from the alpha group, then goes to the configured beta group', async () => {
    const r = await run(['release', 'promote', 'ios', '--from', 'alpha', '--to', 'beta', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(names()).toEqual(['ios promote_build', 'ios promote_testflight'])
    const [lookup, promote] = lanes()
    expect(lookup!.env).toMatchObject({ KIT_IOS_VERSION: '1.4.0', KIT_TESTFLIGHT_FROM_GROUP: 'alpha' })
    expect(lookup!.env.KIT_IOS_BUILD).toBeUndefined()
    expect(promote!.env).toMatchObject({
      KIT_IOS_VERSION: '1.4.0',
      KIT_IOS_BUILD: '7',
      KIT_TESTFLIGHT_FROM_GROUP: 'alpha',
      KIT_TESTFLIGHT_GROUPS: 'Beta Testers',
      KIT_IOS_BUNDLE_ID: 'app.example',
      ASC_KEY_ID: 'KEYID123',
    })
    expect(promote!.env.KIT_ASC_KEY_PATH).toEndWith('asc-key.p8')
    expect(promote!.env.KIT_RELEASE_NOTES).toBeUndefined()
    expect(promote!.env.KIT_IOS_IPA).toBeUndefined()
    expect(JSON.parse(r.stdout)).toMatchObject({
      build: 7,
      promoted: true,
      tag: 'ios/v1.4.0+7',
      tagExisted: false,
    })
  })

  test('ios: a build that is not in the source group (an internal build) is refused, exit 1', async () => {
    fakeBundle(`  *"ios promote_build"*)
    echo "Build 9 of 1.4.0 is not in the TestFlight group 'alpha': only a build released to that group can be promoted (internal builds are never promoted)"
    exit 1 ;;`)
    const r = await run([
      'release',
      'promote',
      'ios',
      '--from',
      'alpha',
      '--to',
      'beta',
      '--build',
      '9',
      '--yes',
      '--json',
    ])
    expect(r.code).toBe(1)
    expect(names()).toEqual(['ios promote_build'])
    expect(lanes()[0]!.env).toMatchObject({ KIT_IOS_BUILD: '9', KIT_TESTFLIGHT_FROM_GROUP: 'alpha' })
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ ok: false, stage: 'resolve', promoted: false, build: 9 })
    expect(doc.results[0].output).toContain("is not in the TestFlight group 'alpha'")
    expect(sh(['git', 'tag'])).toBe('')
  })

  test('ios --app-version: a build from before a version bump; lane version and tag follow it', async () => {
    const r = await run([
      'release',
      'promote',
      'ios',
      '--from',
      'alpha',
      '--to',
      'beta',
      '--app-version',
      '1.3.0',
      '--yes',
      '--json',
    ])
    expect(r.code).toBe(0)
    const [lookup, promote] = lanes()
    expect(lookup!.env.KIT_IOS_VERSION).toBe('1.3.0')
    expect(promote!.env).toMatchObject({ KIT_IOS_VERSION: '1.3.0', KIT_IOS_BUILD: '7' })
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ version: '1.3.0', tag: 'ios/v1.3.0+7', tagExisted: false })
    expect(doc.tagCommand).toContain('git tag -a ios/v1.3.0+7')
  })

  test('--app-version: bad format → exit 2; Android → exit 2', async () => {
    for (const v of ['1.3', 'v1.3.0', '1.3.0-beta']) {
      const bad = await run([
        'release',
        'promote',
        'ios',
        '--from',
        'alpha',
        '--to',
        'beta',
        '--app-version',
        v,
        '--yes',
      ])
      expect(bad.code).toBe(2)
      expect(bad.stderr).toContain('--app-version must be MAJOR.MINOR.PATCH')
    }
    const android = await run([
      'release',
      'promote',
      'android',
      '--from',
      'alpha',
      '--to',
      'beta',
      '--app-version',
      '1.3.0',
      '--yes',
    ])
    expect(android.code).toBe(2)
    expect(android.stderr).toContain('--app-version applies to iOS only')
    expect(lanes()).toEqual([])
  })

  test('ios → prod: needs --notes, then submits the build that is already uploaded', async () => {
    const bare = await run(['release', 'promote', 'ios', '--from', 'beta', '--to', 'prod', '--build', '7'])
    expect(bare.code).toBe(2)
    expect(bare.stderr).toContain('--to prod needs --notes')
    expect(lanes()).toEqual([])
    const r = await run(
      [
        'release',
        'promote',
        'ios',
        '--from',
        'beta',
        '--to',
        'prod',
        '--build',
        '7',
        '--notes',
        'Bug fixes',
        '--json',
      ],
      { GITHUB_ACTIONS: 'true' },
    )
    expect(r.code).toBe(0)
    // --build is still checked against the source group (the configured beta group)
    expect(names()).toEqual(['ios promote_build', 'ios promote_appstore'])
    expect(lanes()[0]!.env).toMatchObject({ KIT_IOS_BUILD: '7', KIT_TESTFLIGHT_FROM_GROUP: 'Beta Testers' })
    expect(lanes()[0]!.env.KIT_RELEASE_NOTES).toBeUndefined()
    expect(lanes()[1]!.env).toMatchObject({
      KIT_IOS_VERSION: '1.4.0',
      KIT_IOS_BUILD: '7',
      KIT_TESTFLIGHT_FROM_GROUP: 'Beta Testers',
      KIT_RELEASE_NOTES: 'Bug fixes',
    })
    expect(lanes()[1]!.env.KIT_TESTFLIGHT_GROUPS).toBeUndefined()
  })
})

describe('kit release rollout', () => {
  test('android --percent: fraction to the rollout lane, --json shape', async () => {
    const r = await run(['release', 'rollout', 'android', '--percent', '25', '--json'], {
      GITHUB_ACTIONS: 'true',
    })
    expect(r.code).toBe(0)
    expect(names()).toEqual(['android rollout'])
    const env = lanes()[0]!.env
    expect(env).toMatchObject({
      KIT_ROLLOUT_ACTION: 'percent',
      KIT_PLAY_ROLLOUT: '0.25',
      KIT_ANDROID_PACKAGE: 'app.example',
    })
    expect(env.KIT_PLAY_JSON_KEY).toEndWith('play.json')
    expect(JSON.parse(r.stdout)).toEqual({
      platform: 'android',
      action: 'percent',
      percent: 25,
      fraction: 0.25,
      dryRun: false,
      ok: true,
      changed: true,
      build: 40,
      state: 'inProgress',
    })
    // the summary names the version code the lane changed
    const human = await run(['release', 'rollout', 'android', '--halt', '--yes'])
    expect(human.stderr).toContain('version code 40: inProgress at 25%')
  })

  test.each(['halt', 'resume', 'complete'])('android --%s', async (action) => {
    // --halt is the brake: --yes is enough. The others widen exposure: the production environment answers.
    const r = await run(
      ['release', 'rollout', 'android', `--${action}`, '--yes'],
      action === 'halt' ? {} : { GITHUB_ACTIONS: 'true' },
    )
    expect(r.code).toBe(0)
    expect(names()).toEqual(['android rollout'])
    expect(lanes()[0]!.env.KIT_ROLLOUT_ACTION).toBe(action)
    expect(lanes()[0]!.env.KIT_PLAY_ROLLOUT).toBeUndefined()
  })

  test('android --build names the release; on iOS it is a usage error', async () => {
    const r = await run(['release', 'rollout', 'android', '--halt', '--build', '41', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(lanes()[0]!.env).toMatchObject({ KIT_ROLLOUT_ACTION: 'halt', KIT_ANDROID_CODE: '41' })
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'halt', build: 41, changed: true })
    const ios = await run(['release', 'rollout', 'ios', '--halt', '--build', '41', '--yes'])
    expect(ios.code).toBe(2)
    expect(ios.stderr).toContain('--build is Android only')
    expect(names()).toEqual(['android rollout'])
  })

  test('ios --halt pauses the phased release', async () => {
    const r = await run(['release', 'rollout', 'ios', '--halt', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(names()).toEqual(['ios rollout'])
    const env = lanes()[0]!.env
    expect(env).toMatchObject({ KIT_ROLLOUT_ACTION: 'halt', KIT_IOS_BUNDLE_ID: 'app.example' })
    expect(env.KIT_ASC_KEY_PATH).toEndWith('asc-key.p8')
    expect(JSON.parse(r.stdout)).toEqual({
      platform: 'ios',
      action: 'halt',
      dryRun: false,
      ok: true,
      changed: true,
      state: 'PAUSED',
      version: '1.3.0',
    })
  })

  test('usage: iOS has no --percent; exactly one action; percent in 1-100', async () => {
    const ios = await run(['release', 'rollout', 'ios', '--percent', '50', '--yes'])
    expect(ios.code).toBe(2)
    expect(ios.stderr).toContain('the App Store has no rollout percentage')
    expect(ios.stderr).toContain('Use --halt, --resume or --complete')
    const two = await run(['release', 'rollout', 'android', '--halt', '--resume', '--yes'])
    expect(two.code).toBe(2)
    expect(two.stderr).toContain('exactly one of')
    expect((await run(['release', 'rollout', 'android', '--yes'])).code).toBe(2)
    expect((await run(['release', 'rollout', 'android', '--percent', '0', '--yes'])).code).toBe(2)
    expect((await run(['release', 'rollout', '--halt', '--yes'])).code).toBe(2)
    expect(lanes()).toEqual([])
  })

  test.each([
    'android --percent 25',
    'android --resume',
    'android --complete',
    'ios --resume',
    'ios --complete',
  ])('%s widens exposure: --yes off a terminal is refused', async (args) => {
    const r = await run(['release', 'rollout', ...args.split(' '), '--yes'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--yes does not skip it')
    expect(lanes()).toEqual([])
  })

  test('--halt without --yes off a terminal: nothing runs', async () => {
    const r = await run(['release', 'rollout', 'android', '--halt'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Re-run with --yes')
    expect(lanes()).toEqual([])
  })

  test('--dry-run runs nothing', async () => {
    const r = await run(['release', 'rollout', 'android', '--percent', '50', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      platform: 'android',
      action: 'percent',
      percent: 50,
      fraction: 0.5,
      dryRun: true,
      ok: true,
      changed: false,
      plan: ['fastlane android rollout'],
    })
    expect(lanes()).toEqual([])
  })

  test('a failing lane exits 1 with the resume hint', async () => {
    fakeBundle('  *"android rollout"*) echo "Unable to find the requested release"; exit 1 ;;')
    const r = await run(['release', 'rollout', 'android', '--percent', '50'], { GITHUB_ACTIONS: 'true' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Unable to find the requested release')
    expect(r.stderr).toContain('kit release rollout android --resume')
  })
})

test('kit release --help lists status, promote and rollout', async () => {
  const r = await run(['release', '--help'])
  expect(r.code).toBe(0)
  for (const name of ['status', 'promote', 'rollout'])
    expect(r.stdout).toMatch(new RegExp(`^\\s+${name}\\s`, 'm'))
})
