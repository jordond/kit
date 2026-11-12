import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const b64 = (s: string) => Buffer.from(s).toString('base64')
// Only the store API keys: listing sync needs no match repo and no keystore.
const SECRETS = {
  ASC_KEY_ID: 'KEYID123',
  ASC_ISSUER_ID: 'issuer-uuid',
  ASC_KEY_P8_BASE64: b64('-----BEGIN PRIVATE KEY-----\nMIGTAgEAsecretbody\n-----END PRIVATE KEY-----\n'),
  PLAY_SERVICE_ACCOUNT_BASE64: b64('{"type": "service_account", "private_key": "pk-value"}'),
}

interface LaneCall {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

let f: Fixture
let laneLog: string

const real = (p: string) => p.replace(/^\/private/, '')

function sh(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { cwd: f.dir, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function put(path: string, body = 'x') {
  mkdirSync(dirname(join(f.dir, path)), { recursive: true })
  writeFileSync(join(f.dir, path), body)
}

function lanes(): LaneCall[] {
  return readFileSync(laneLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LaneCall)
    .filter((c) => c.argv[0] === 'exec')
}

const lane = (c: LaneCall) => c.argv.slice(2).join(' ')

const run = (args: string[], env: Record<string, string> = {}) =>
  f.kit(args, { env: { ...SECRETS, GITHUB_ACTIONS: '', ...env } })

/** Point release.<platform>.metadata at the fastlane-standard dirs in the fixture's copy. */
function configure(keys: { ios?: string; android?: string }) {
  const file = join(f.dir, 'kit.config.ts')
  let text = readFileSync(file, 'utf8')
  if (keys.ios) text = text.replace("scheme: 'iosApp',", `scheme: 'iosApp',\n      metadata: '${keys.ios}',`)
  if (keys.android)
    text = text.replace("module: ':android',", `module: ':android',\n      metadata: '${keys.android}',`)
  writeFileSync(file, text)
}

const IOS_DIR = 'client/fastlane/metadata'
const ANDROID_DIR = 'client/fastlane/metadata/android'

beforeEach(() => {
  f = fixture('release', ['bundle'])
  laneLog = join(f.dir, '.lanes.log')
  writeFileSync(laneLog, '')
  // Fake bundle: records argv/cwd/env; the pull lanes write a listing file like the real ones.
  f.script(
    'bundle',
    `bun -e 'const e=process.env;console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),env:Object.fromEntries(Object.entries(e).filter(([k])=>/^(KIT_|BUNDLE_|FASTLANE_|FL_|ASC_|MATCH_|ANDROID_)/.test(k)))}))' -- "$@" >> "${laneLog}"
case "$*" in
  *"ios metadata_pull"*) mkdir -p "$KIT_METADATA_PATH/en-US" "$KIT_SCREENSHOTS_PATH/en-US"; echo pulled > "$KIT_METADATA_PATH/en-US/name.txt"; echo png > "$KIT_SCREENSHOTS_PATH/en-US/0_APP_IPHONE_67_0.png" ;;
  *"android metadata_pull"*) mkdir -p "$KIT_METADATA_PATH/en-US"; echo pulled > "$KIT_METADATA_PATH/en-US/title.txt" ;;
esac
exit 0`,
  )
  configure({ ios: IOS_DIR, android: ANDROID_DIR })
  put(`${IOS_DIR}/en-US/name.txt`, 'App')
  put(`${IOS_DIR}/en-US/description.txt`, 'An app')
  put(`${IOS_DIR}/review_information/notes.txt`, 'hello reviewer')
  put('client/fastlane/screenshots/en-US/0_APP_IPHONE_67_0.png')
  put(`${ANDROID_DIR}/en-US/title.txt`, 'App')
  put(`${ANDROID_DIR}/en-US/full_description.txt`, 'An app')
  put(`${ANDROID_DIR}/en-US/changelogs/42.txt`, 'notes')
  put(`${ANDROID_DIR}/en-US/images/icon.png`)
  put(`${ANDROID_DIR}/en-US/images/phoneScreenshots/1_en-US.png`)
  sh(['git', 'init', '-q', '-b', 'main'])
  sh(['git', 'config', 'user.email', 't@example.com'])
  sh(['git', 'config', 'user.name', 'T'])
  writeFileSync(join(f.dir, '.gitignore'), '.fakebin/\n.calls.log\n.lanes.log\nnode_modules/\n')
  sh(['git', 'add', '-A'])
  sh(['git', 'commit', '-qm', 'feat: first'])
})

afterEach(() => f.cleanup())

const IOS_TEXT = [
  `${IOS_DIR}/en-US/description.txt`,
  `${IOS_DIR}/en-US/name.txt`,
  `${IOS_DIR}/review_information/notes.txt`,
]
const ANDROID_TEXT = [`${ANDROID_DIR}/en-US/title.txt`, `${ANDROID_DIR}/en-US/full_description.txt`]
const ANDROID_IMAGES = [
  `${ANDROID_DIR}/en-US/images/icon.png`,
  `${ANDROID_DIR}/en-US/images/phoneScreenshots/1_en-US.png`,
]

describe('kit release metadata push', () => {
  test('ios --yes: one metadata_push lane, text only, ASC key and no match secrets', async () => {
    const r = await run(['release', 'metadata', 'push', 'ios', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      platform: 'ios',
      action: 'push',
      dir: IOS_DIR,
      screenshots: false,
      files: IOS_TEXT,
      dryRun: false,
      ok: true,
    })
    const calls = lanes()
    expect(calls.map(lane)).toEqual(['ios metadata_push'])
    const c = calls[0]!
    expect(real(c.cwd)).toBe(real(join(f.dir, 'client')))
    expect(c.env.KIT_FASTFILE).toEndWith('/fastlane/Fastfile')
    expect(real(c.env.KIT_METADATA_PATH!)).toBe(real(join(f.dir, IOS_DIR)))
    expect(real(c.env.KIT_SCREENSHOTS_PATH!)).toBe(real(join(f.dir, 'client/fastlane/screenshots')))
    expect(c.env).toMatchObject({
      KIT_IOS_BUNDLE_ID: 'app.example',
      ASC_KEY_ID: 'KEYID123',
      ASC_ISSUER_ID: 'issuer-uuid',
    })
    expect(c.env.KIT_ASC_KEY_PATH).toMatch(/asc-key\.p8$/)
    expect(c.env.KIT_METADATA_SCREENSHOTS).toBeUndefined()
    expect(c.env.MATCH_PASSWORD).toBeUndefined()
    // never a binary, a track or a rollout
    for (const k of ['KIT_IOS_IPA', 'KIT_RELEASE_NOTES', 'KIT_TESTFLIGHT_GROUPS', 'KIT_APPSTORE_SUBMIT']) {
      expect(c.env[k]).toBeUndefined()
    }
    expect(await Bun.file(c.env.KIT_ASC_KEY_PATH!).exists()).toBe(false)
  })

  test('ios --screenshots --yes: passes KIT_METADATA_SCREENSHOTS and lists the screenshots', async () => {
    const r = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).files).toEqual([
      ...IOS_TEXT,
      'client/fastlane/screenshots/en-US/0_APP_IPHONE_67_0.png',
    ])
    expect(lanes()[0]!.env.KIT_METADATA_SCREENSHOTS).toBe('1')
  })

  test('android --screenshots --yes: metadata_push with the Play key; changelogs are never sent', async () => {
    const r = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({
      platform: 'android',
      screenshots: true,
      files: [...ANDROID_TEXT, ...ANDROID_IMAGES],
      ok: true,
    })
    const calls = lanes()
    expect(calls.map(lane)).toEqual(['android metadata_push'])
    const env = calls[0]!.env
    expect(real(env.KIT_METADATA_PATH!)).toBe(real(join(f.dir, ANDROID_DIR)))
    expect(env).toMatchObject({ KIT_ANDROID_PACKAGE: 'app.example', KIT_METADATA_SCREENSHOTS: '1' })
    expect(env.KIT_PLAY_JSON_KEY).toMatch(/play\.json$/)
    expect(env.KIT_SCREENSHOTS_PATH).toBeUndefined()
    for (const k of ['KIT_ANDROID_AAB', 'KIT_PLAY_TRACK', 'KIT_PLAY_ROLLOUT', 'KIT_RELEASE_NOTES']) {
      expect(env[k]).toBeUndefined()
    }
  })

  test('android without --screenshots: text only, no KIT_METADATA_SCREENSHOTS', async () => {
    const r = await run(['release', 'metadata', 'push', 'android', '-y', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).files).toEqual(ANDROID_TEXT)
    expect(lanes()[0]!.env.KIT_METADATA_SCREENSHOTS).toBeUndefined()
  })

  test('without --yes off a terminal: shows the files, refuses to confirm (exit 2), runs nothing', async () => {
    const r = await run(['release', 'metadata', 'push', 'ios'])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('App ios listing → App Store (app.example)')
    expect(r.stderr).toContain(`${IOS_DIR}/en-US/name.txt`)
    expect(r.stderr).toContain('Re-run with --yes')
    expect(lanes()).toEqual([])
  })

  test('--dry-run lists the files on stdout and runs nothing, with no secrets set', async () => {
    const none = { ASC_KEY_ID: '', ASC_ISSUER_ID: '', ASC_KEY_P8_BASE64: '', PLAY_SERVICE_ACCOUNT_BASE64: '' }
    const r = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--dry-run'], none)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${[...ANDROID_TEXT, ...ANDROID_IMAGES].join('\n')}\n`)
    expect(r.stderr).toContain('would push 2 text files and 2 images to the Google Play listing of app.example')
    expect(readFileSync(laneLog, 'utf8')).toBe('')

    const j = await run(['release', 'metadata', 'push', 'ios', '-n', '--json'], none)
    expect(j.code).toBe(0)
    expect(JSON.parse(j.stdout)).toEqual({
      platform: 'ios',
      action: 'push',
      dir: IOS_DIR,
      screenshots: false,
      files: IOS_TEXT,
      dryRun: true,
    })
    expect(readFileSync(laneLog, 'utf8')).toBe('')
  })

  test('a failing lane exits 1 with ok: false', async () => {
    f.script('bundle', 'case "$*" in *metadata_push*) echo "deliver exploded"; exit 1 ;; esac; exit 0')
    const r = await run(['release', 'metadata', 'push', 'ios', '--yes', '--json'])
    expect(r.code).toBe(1)
    const doc = JSON.parse(r.stdout)
    expect(doc.ok).toBe(false)
    expect(doc.results[0].output).toContain('deliver exploded')
  })

  test('missing release.<platform>.metadata is a usage error naming the key', async () => {
    writeFileSync(
      join(f.dir, 'kit.config.ts'),
      readFileSync(join(f.dir, 'kit.config.ts'), 'utf8').replace(`      metadata: '${IOS_DIR}',\n`, ''),
    )
    for (const action of ['push', 'pull']) {
      const r = await run(['release', 'metadata', action, 'ios', '--yes'])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('No release.ios.metadata in kit.config.ts')
    }
    expect(lanes()).toEqual([])
  })

  test('a missing directory is a usage error naming the key', async () => {
    rmSync(join(f.dir, ANDROID_DIR), { recursive: true })
    const r = await run(['release', 'metadata', 'push', 'android', '--yes', '--json'])
    expect(r.code).toBe(2)
    const doc = JSON.parse(r.stdout)
    expect(doc.ok).toBe(false)
    expect(JSON.stringify(doc.error)).toContain('release.android.metadata')
    expect(lanes()).toEqual([])
  })

  test('--screenshots with no images stops before the store is touched (exit 4)', async () => {
    rmSync(join(f.dir, 'client/fastlane/screenshots'), { recursive: true })
    const r = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('--screenshots: no images in client/fastlane/screenshots')
    expect(lanes()).toEqual([])
  })

  test('needs a platform', async () => {
    const r = await run(['release', 'metadata', 'push', '--yes'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('needs a platform: ios | android')
    const bad = await run(['release', 'metadata', 'pull', 'web'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('(got "web")')
  })
})

describe('kit release metadata pull', () => {
  test('ios: one metadata_pull lane with both directories; no confirmation', async () => {
    const r = await run(['release', 'metadata', 'pull', 'ios', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      platform: 'ios',
      action: 'pull',
      dir: IOS_DIR,
      screenshotsDir: 'client/fastlane/screenshots',
      dryRun: false,
      ok: true,
      files: [...IOS_TEXT, 'client/fastlane/screenshots/en-US/0_APP_IPHONE_67_0.png'],
    })
    const calls = lanes()
    expect(calls.map(lane)).toEqual(['ios metadata_pull'])
    const env = calls[0]!.env
    expect(real(env.KIT_METADATA_PATH!)).toBe(real(join(f.dir, IOS_DIR)))
    expect(real(env.KIT_SCREENSHOTS_PATH!)).toBe(real(join(f.dir, 'client/fastlane/screenshots')))
    expect(env).toMatchObject({ KIT_IOS_BUNDLE_ID: 'app.example', ASC_KEY_ID: 'KEYID123' })
    expect(env.KIT_ASC_KEY_PATH).toMatch(/asc-key\.p8$/)
    expect(readFileSync(join(f.dir, IOS_DIR, 'en-US/name.txt'), 'utf8')).toBe('pulled\n')
  })

  test('android: metadata_pull with the Play key', async () => {
    const r = await run(['release', 'metadata', 'pull', 'android'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    const calls = lanes()
    expect(calls.map(lane)).toEqual(['android metadata_pull'])
    const env = calls[0]!.env
    expect(real(env.KIT_METADATA_PATH!)).toBe(real(join(f.dir, ANDROID_DIR)))
    expect(env.KIT_ANDROID_PACKAGE).toBe('app.example')
    expect(env.KIT_PLAY_JSON_KEY).toMatch(/play\.json$/)
    expect(env.KIT_SCREENSHOTS_PATH).toBeUndefined()
    expect(readFileSync(join(f.dir, ANDROID_DIR, 'en-US/title.txt'), 'utf8')).toBe('pulled\n')
  })

  test('refuses a dirty directory (exit 4); --force overwrites', async () => {
    put(`${ANDROID_DIR}/en-US/title.txt`, 'edited, not committed')
    const r = await run(['release', 'metadata', 'pull', 'android'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain(`A pull would overwrite uncommitted changes in ${ANDROID_DIR}`)
    expect(r.stderr).toContain(`${ANDROID_DIR}/en-US/title.txt`)
    expect(r.stderr).toContain('--force')
    expect(lanes()).toEqual([])
    expect(readFileSync(join(f.dir, ANDROID_DIR, 'en-US/title.txt'), 'utf8')).toBe('edited, not committed')

    const forced = await run(['release', 'metadata', 'pull', 'android', '--force'])
    expect(forced.code).toBe(0)
    expect(lanes().map(lane)).toEqual(['android metadata_pull'])
    expect(readFileSync(join(f.dir, ANDROID_DIR, 'en-US/title.txt'), 'utf8')).toBe('pulled\n')
  })

  test('ios: a dirty screenshots directory counts too', async () => {
    put('client/fastlane/screenshots/en-US/new.png')
    const r = await run(['release', 'metadata', 'pull', 'ios'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('client/fastlane/screenshots/')
    expect(lanes()).toEqual([])
  })

  test('a first pull creates the directory', async () => {
    rmSync(join(f.dir, ANDROID_DIR), { recursive: true })
    sh(['git', 'commit', '-qam', 'chore: drop the listing'])
    const r = await run(['release', 'metadata', 'pull', 'android', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).files).toEqual([`${ANDROID_DIR}/en-US/title.txt`])
  })

  test('--dry-run runs nothing', async () => {
    const r = await run(['release', 'metadata', 'pull', 'ios', '--dry-run'], { ASC_KEY_P8_BASE64: '' })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(
      `would download the App Store listing of app.example into ${IOS_DIR} and client/fastlane/screenshots`,
    )
    expect(readFileSync(laneLog, 'utf8')).toBe('')
    expect(sh(['git', 'status', '--porcelain'])).toBe('')
  })

  test('missing store key is a config error (exit 3) before any lane', async () => {
    const r = await run(['release', 'metadata', 'pull', 'android'], { PLAY_SERVICE_ACCOUNT_BASE64: '' })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('Missing release secrets: PLAY_SERVICE_ACCOUNT_BASE64')
    expect(lanes()).toEqual([])
  })
})
