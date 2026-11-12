import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { encodePng } from '../../src/lib/image/png'
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

const pngs = new Map<string, Uint8Array>()

/** A real PNG of this size: opaque (RGB), or RGBA with `alpha`. Encoded once per size. */
function png(width: number, height: number, alpha = false): Uint8Array {
  const key = `${width}x${height}${alpha ? 'a' : ''}`
  let bytes = pngs.get(key)
  if (!bytes) {
    bytes = encodePng(width, height, new Uint8Array(width * height * (alpha ? 4 : 3)))
    pngs.set(key, bytes)
  }
  return bytes
}

const IPHONE = () => png(1320, 2868)
const PHONE = () => png(1440, 2560)

function put(path: string, body: string | Uint8Array = 'x') {
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
const IOS_SHOTS = 'client/fastlane/screenshots'
const IOS_SHOT = `${IOS_SHOTS}/en-US/0_APP_IPHONE_67_0.png`
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
  *"ios metadata_pull"*) mkdir -p "$KIT_METADATA_PATH/en-US" "$KIT_METADATA_PATH/review_information"; echo pulled > "$KIT_METADATA_PATH/en-US/name.txt"; echo s3cret > "$KIT_METADATA_PATH/review_information/demo_password.txt"
    if [ "$KIT_METADATA_SCREENSHOTS" = 1 ]; then mkdir -p "$KIT_SCREENSHOTS_PATH/en-US"; echo pulled > "$KIT_SCREENSHOTS_PATH/en-US/0_APP_IPHONE_67_0.png"; fi ;;
  *"android metadata_pull"*) mkdir -p "$KIT_METADATA_PATH/en-US/images"; echo pulled > "$KIT_METADATA_PATH/en-US/title.txt"
    if [ "$KIT_METADATA_SCREENSHOTS" = 1 ]; then echo pulled > "$KIT_METADATA_PATH/en-US/images/icon.png"; fi ;;
esac
exit 0`,
  )
  configure({ ios: IOS_DIR, android: ANDROID_DIR })
  put(`${IOS_DIR}/en-US/name.txt`, 'App')
  put(`${IOS_DIR}/en-US/description.txt`, 'An app')
  put(`${IOS_DIR}/review_information/demo_password.txt`, 'hunter2')
  put(IOS_SHOT, IPHONE())
  put(`${ANDROID_DIR}/en-US/title.txt`, 'App')
  put(`${ANDROID_DIR}/en-US/full_description.txt`, 'An app')
  put(`${ANDROID_DIR}/en-US/changelogs/42.txt`, 'notes')
  put(`${ANDROID_DIR}/en-US/images/icon.png`, png(512, 512, true))
  put(`${ANDROID_DIR}/en-US/images/phoneScreenshots/1_en-US.png`, PHONE())
  put(`${ANDROID_DIR}/en-US/images/phoneScreenshots/2_en-US.png`, PHONE())
  sh(['git', 'init', '-q', '-b', 'main'])
  sh(['git', 'config', 'user.email', 't@example.com'])
  sh(['git', 'config', 'user.name', 'T'])
  writeFileSync(join(f.dir, '.gitignore'), '.fakebin/\n.calls.log\n.lanes.log\nnode_modules/\n')
  sh(['git', 'add', '-A'])
  sh(['git', 'commit', '-qm', 'feat: first'])
})

afterEach(() => f.cleanup())

const IOS_TEXT = [`${IOS_DIR}/en-US/description.txt`, `${IOS_DIR}/en-US/name.txt`]
const ANDROID_TEXT = [`${ANDROID_DIR}/en-US/title.txt`, `${ANDROID_DIR}/en-US/full_description.txt`]
const ANDROID_IMAGES = [
  `${ANDROID_DIR}/en-US/images/icon.png`,
  `${ANDROID_DIR}/en-US/images/phoneScreenshots/1_en-US.png`,
  `${ANDROID_DIR}/en-US/images/phoneScreenshots/2_en-US.png`,
]
const IOS_IMAGE = { file: IOS_SHOT, locale: 'en-US', class: 'APP_IPHONE_67', width: 1320, height: 2868 }
const ANDROID_IMAGE_INFO = [
  { file: ANDROID_IMAGES[0], locale: 'en-US', class: 'icon', width: 512, height: 512 },
  { file: ANDROID_IMAGES[1], locale: 'en-US', class: 'phoneScreenshots', width: 1440, height: 2560 },
  { file: ANDROID_IMAGES[2], locale: 'en-US', class: 'phoneScreenshots', width: 1440, height: 2560 },
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
      images: [],
      problems: [],
      warnings: [],
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
    expect(c.env).toMatchObject({ KIT_METADATA_SCREENSHOTS: '0', KIT_METADATA_TEXT: '1' })
    expect(c.env.MATCH_PASSWORD).toBeUndefined()
    // never a binary, a track or a rollout
    for (const k of ['KIT_IOS_IPA', 'KIT_RELEASE_NOTES', 'KIT_TESTFLIGHT_GROUPS', 'KIT_APPSTORE_SUBMIT']) {
      expect(c.env[k]).toBeUndefined()
    }
    expect(await Bun.file(c.env.KIT_ASC_KEY_PATH!).exists()).toBe(false)
  })

  test('ios: review_information is never in the file plan, dry run or not', async () => {
    const dry = await run(['release', 'metadata', 'push', 'ios', '--dry-run'])
    expect(dry.stdout).toBe(`${IOS_TEXT.join('\n')}\n`)
    const r = await run(['release', 'metadata', 'push', 'ios'])
    expect(r.code).toBe(2)
    expect(r.stderr).not.toContain('review_information')
  })

  test('ios --screenshots --yes: passes KIT_METADATA_SCREENSHOTS and lists the screenshots', async () => {
    const r = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.files).toEqual([...IOS_TEXT, IOS_SHOT])
    expect(doc.images).toEqual([IOS_IMAGE])
    expect(doc.problems).toEqual([])
    const env = lanes()[0]!.env
    expect(env).toMatchObject({ KIT_METADATA_SCREENSHOTS: '1', KIT_METADATA_TEXT: '1' })
  })

  test('android --screenshots --yes: metadata_push with the Play key; changelogs are never sent', async () => {
    const r = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({
      platform: 'android',
      screenshots: true,
      files: [...ANDROID_TEXT, ...ANDROID_IMAGES],
      images: ANDROID_IMAGE_INFO,
      problems: [],
      ok: true,
    })
    const calls = lanes()
    expect(calls.map(lane)).toEqual(['android metadata_push'])
    const env = calls[0]!.env
    expect(real(env.KIT_METADATA_PATH!)).toBe(real(join(f.dir, ANDROID_DIR)))
    expect(env).toMatchObject({
      KIT_ANDROID_PACKAGE: 'app.example',
      KIT_METADATA_SCREENSHOTS: '1',
      KIT_METADATA_TEXT: '1',
    })
    expect(env.KIT_PLAY_JSON_KEY).toMatch(/play\.json$/)
    expect(env.KIT_SCREENSHOTS_PATH).toBeUndefined()
    for (const k of ['KIT_ANDROID_AAB', 'KIT_PLAY_TRACK', 'KIT_PLAY_ROLLOUT', 'KIT_RELEASE_NOTES']) {
      expect(env[k]).toBeUndefined()
    }
  })

  test('android without --screenshots: text only, KIT_METADATA_SCREENSHOTS=0', async () => {
    const r = await run(['release', 'metadata', 'push', 'android', '-y', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).files).toEqual(ANDROID_TEXT)
    expect(lanes()[0]!.env).toMatchObject({ KIT_METADATA_SCREENSHOTS: '0', KIT_METADATA_TEXT: '1' })
  })

  test('the lane switches are kit’s, whatever the shell or a root .env holds', async () => {
    // inherited values that would flip each switch if kit left it unset
    const hostile = { KIT_METADATA_SCREENSHOTS: '1', KIT_METADATA_TEXT: '0' }
    const text = await run(['release', 'metadata', 'push', 'ios', '--yes', '--json'], hostile)
    expect(text.code).toBe(0)
    expect(JSON.parse(text.stdout)).toMatchObject({ screenshots: false, files: IOS_TEXT, images: [] })
    expect(lanes()[0]!.env).toMatchObject({ KIT_METADATA_SCREENSHOTS: '0', KIT_METADATA_TEXT: '1' })

    const both = await run(
      ['release', 'metadata', 'push', 'android', '--screenshots', '-y', '--json'],
      hostile,
    )
    expect(both.code).toBe(0)
    expect(JSON.parse(both.stdout).files).toEqual([...ANDROID_TEXT, ...ANDROID_IMAGES])
    expect(lanes()[1]!.env).toMatchObject({ KIT_METADATA_SCREENSHOTS: '1', KIT_METADATA_TEXT: '1' })

    const only = await run(['release', 'metadata', 'push', 'ios', '--only-screenshots', '-y'], {
      KIT_METADATA_SCREENSHOTS: '0',
      KIT_METADATA_TEXT: '1',
    })
    expect(only.code).toBe(0)
    expect(lanes()[2]!.env).toMatchObject({ KIT_METADATA_SCREENSHOTS: '1', KIT_METADATA_TEXT: '0' })
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
    expect(r.stderr).toContain(
      'would push 2 text files and 3 images to the Google Play listing of app.example',
    )
    expect(readFileSync(laneLog, 'utf8')).toBe('')

    const j = await run(['release', 'metadata', 'push', 'ios', '-n', '--json'], none)
    expect(j.code).toBe(0)
    expect(JSON.parse(j.stdout)).toEqual({
      platform: 'ios',
      action: 'push',
      dir: IOS_DIR,
      screenshots: false,
      files: IOS_TEXT,
      images: [],
      problems: [],
      warnings: [],
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
    const only = await run(['release', 'metadata', 'push', 'ios', '--only-screenshots', '--yes'])
    expect(only.code).toBe(4)
    expect(only.stderr).toContain('--only-screenshots: no images in client/fastlane/screenshots')
    expect(lanes()).toEqual([])
  })

  test('the card shows count and size per locale and class, and what an iOS push replaces', async () => {
    put(`${IOS_SHOTS}/en-US/1_ipad.png`, png(2064, 2752))
    put(`${IOS_SHOTS}/fr-FR/0_iphone.png`, IPHONE())
    const r = await run(['release', 'metadata', 'push', 'ios', '--screenshots'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('en-US  APP_IPHONE_67  1 × 1320x2868')
    expect(r.stderr).toContain('en-US  APP_IPAD_PRO_3GEN_129  1 × 2064x2752')
    expect(r.stderr).toContain('fr-FR  APP_IPHONE_67  1 × 1320x2868')
    expect(r.stderr).toContain('replaces every screenshot set of: en-US, fr-FR')

    const play = await run(['release', 'metadata', 'push', 'android', '--screenshots'])
    expect(play.stderr).toContain('en-US  phoneScreenshots  2 × 1440x2560')
    expect(play.stderr).toContain('en-US  icon  1 × 512x512')
    expect(play.stderr).not.toContain('replaces every screenshot set')

    const text = await run(['release', 'metadata', 'push', 'ios'])
    expect(text.stderr).not.toContain('replaces every screenshot set')
    expect(lanes()).toEqual([])
  })

  test('an image with alpha stops the push (exit 4) before the confirmation, and is left as it was', async () => {
    const shot = `${IOS_SHOTS}/en-US/1_alpha.png`
    put(shot, png(1320, 2868, true))
    const before = readFileSync(join(f.dir, shot))
    const r = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('App Store would refuse these images:')
    expect(r.stderr).toContain(`${shot}: has an alpha channel`)
    expect(r.stderr).not.toContain(`${IOS_SHOT}:`)
    expect(r.stderr).not.toContain('Push ')
    expect(lanes()).toEqual([])
    expect(readFileSync(join(f.dir, shot)).equals(before)).toBe(true)
    // the Play icon may carry alpha (the fixture's does); a screenshot may not
    put(`${ANDROID_DIR}/en-US/images/phoneScreenshots/3_en-US.png`, png(1440, 2560, true))
    const play = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes'])
    expect(play.code).toBe(4)
    expect(play.stderr).toContain('phoneScreenshots/3_en-US.png: has an alpha channel')
    expect(play.stderr).not.toContain('icon.png')
    expect(lanes()).toEqual([])
  })

  test('every bad file is listed with its reason, in --dry-run and in --json too', async () => {
    const odd = `${IOS_SHOTS}/en-US/1_odd.png`
    const fake = `${IOS_SHOTS}/en-US/2_fake.png`
    put(odd, png(1344, 2992))
    put(fake, 'x')
    const dry = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--dry-run'])
    expect(dry.code).toBe(4)
    expect(dry.stdout).toBe('')
    expect(dry.stderr).toContain(`${odd}: 1344x2992 is not an App Store screenshot size`)
    expect(dry.stderr).toContain(`${fake}: Not a PNG or JPEG image`)

    const j = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes', '--json'])
    expect(j.code).toBe(4)
    const doc = JSON.parse(j.stdout)
    expect(doc).toMatchObject({
      platform: 'ios',
      ok: false,
      dryRun: false,
      files: [...IOS_TEXT, IOS_SHOT, odd, fake],
      problems: [`${odd}: 1344x2992 is not an App Store screenshot size`, `${fake}: Not a PNG or JPEG image`],
    })
    expect(doc.images).toEqual([
      IOS_IMAGE,
      { file: odd, locale: 'en-US', class: 'unknown', width: 1344, height: 2992 },
    ])
    expect(lanes()).toEqual([])
    // a text-only push never reads the images
    const text = await run(['release', 'metadata', 'push', 'ios', '--yes'])
    expect(text.code).toBe(0)
  })

  test('an eleventh screenshot of one iOS class is refused: deliver would drop it and exit 0', async () => {
    for (let i = 1; i <= 10; i++) put(`${IOS_SHOTS}/en-US/${i}_APP_IPHONE_67_${i}.png`, IPHONE())
    const r = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain(
      `${IOS_SHOTS}/en-US/9_APP_IPHONE_67_9.png: the 11th APP_IPHONE_67 image of en-US; the store keeps at most 10`,
    )
    expect(lanes()).toEqual([])
    rmSync(join(f.dir, `${IOS_SHOTS}/en-US/9_APP_IPHONE_67_9.png`))
    const ten = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes'])
    expect(ten.code).toBe(0)
  })

  test('a Play screenshot longer than twice its width is refused', async () => {
    const tall = `${ANDROID_DIR}/en-US/images/phoneScreenshots/3_en-US.png`
    put(tall, png(1344, 2992))
    const r = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('Google Play would refuse these images:')
    expect(r.stderr).toContain(`${tall}: 1344x2992: the long side must be at most 2x the short side`)
    expect(lanes()).toEqual([])
  })

  test('a single Play phone screenshot is a warning, not a refusal', async () => {
    rmSync(join(f.dir, `${ANDROID_DIR}/en-US/images/phoneScreenshots/2_en-US.png`))
    const r = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('en-US: 1 phone screenshot; Google Play asks for at least 2')
    expect(lanes().map(lane)).toEqual(['android metadata_push'])
    // the JSON document carries it, pushed or dry
    const warnings = ['en-US: 1 phone screenshot; Google Play asks for at least 2']
    const j = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes', '--json'])
    expect(JSON.parse(j.stdout)).toMatchObject({ ok: true, problems: [], warnings })
    const dry = await run(['release', 'metadata', 'push', 'android', '--screenshots', '-n', '--json'])
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, warnings })
  })

  test('only what deliver uploads is checked, listed and counted', async () => {
    // frameit's layout: deliver skips root files and fonts/
    put(`${IOS_SHOTS}/background.png`, png(100, 100, true))
    put(`${IOS_SHOTS}/fonts/x.png`, 'x')
    put(`${IOS_SHOTS}/android/en-US/images/icon.png`, png(512, 512, true))
    // framed mode: of fr-FR only the framed file goes up
    put(`${IOS_SHOTS}/fr-FR/01.png`, png(100, 100, true))
    put(`${IOS_SHOTS}/fr-FR/01_framed.png`, IPHONE())
    const r = await run(['release', 'metadata', 'push', 'ios', '--only-screenshots', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${IOS_SHOT}\n${IOS_SHOTS}/fr-FR/01_framed.png\n`)
    expect(r.stderr).toContain('would push 2 images to the App Store listing')
    expect(r.stderr).toContain('fr-FR  APP_IPHONE_67  1 × 1320x2868')
    const j = await run(['release', 'metadata', 'push', 'ios', '--only-screenshots', '--yes', '--json'])
    expect(j.code).toBe(0)
    const doc = JSON.parse(j.stdout)
    expect(doc.files).toEqual([IOS_SHOT, `${IOS_SHOTS}/fr-FR/01_framed.png`])
    expect(doc.images.map((i: { file: string }) => i.file)).toEqual(doc.files)
  })

  test('only what supply uploads is checked, listed and counted', async () => {
    put(`${ANDROID_DIR}/en-US/images/promoGraphic.png`, png(180, 120, true))
    put(`${ANDROID_DIR}/en-US/images/phoneScreenshots/raw/a.png`, png(100, 100, true))
    const r = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.files).toEqual([...ANDROID_TEXT, ...ANDROID_IMAGES])
    expect(doc.images).toEqual(ANDROID_IMAGE_INFO)
  })

  test('10 app screenshots and an iMessage one are two classes', async () => {
    for (let i = 1; i <= 9; i++) put(`${IOS_SHOTS}/en-US/${i}_APP_IPHONE_67_${i}.png`, IPHONE())
    put(`${IOS_SHOTS}/iMessage/en-US/0.png`, IPHONE())
    const r = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('en-US  APP_IPHONE_67  10 × 1320x2868')
    expect(r.stderr).toContain('en-US  IMESSAGE_APP_IPHONE_67  1 × 1320x2868')
  })

  test('a screenshots directory deliver gives no locale, or does not take, stops the push (exit 4)', async () => {
    put(`${IOS_SHOTS}/default/01.png`, IPHONE())
    const r = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain(`${IOS_SHOTS}/default: deliver gives this directory no locale`)
    rmSync(join(f.dir, `${IOS_SHOTS}/default`), { recursive: true })

    put(`${IOS_SHOTS}/en/01.png`, IPHONE())
    const j = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes', '--json'])
    expect(j.code).toBe(4)
    const doc = JSON.parse(j.stdout)
    expect(doc).toMatchObject({ ok: false, files: [...IOS_TEXT, IOS_SHOT], images: [IOS_IMAGE] })
    expect(doc.problems).toEqual([
      expect.stringContaining(`${IOS_SHOTS}/en: deliver does not take this directory name`),
    ])
    // alone in the directory it is still the problem named, not "no images"
    rmSync(join(f.dir, `${IOS_SHOTS}/en-US`), { recursive: true })
    const alone = await run(['release', 'metadata', 'push', 'ios', '--only-screenshots', '--yes'])
    expect(alone.code).toBe(4)
    expect(alone.stderr).toContain(`${IOS_SHOTS}/en: deliver does not take this directory name`)
    expect(lanes()).toEqual([])
  })

  test('a Play tvBanner of another size is refused', async () => {
    const banner = `${ANDROID_DIR}/en-US/images/tvBanner.png`
    put(banner, png(1024, 500))
    const r = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain(`${banner}: 1024x500; the TV banner must be 1280x720`)
    expect(lanes()).toEqual([])
  })

  test('--only-screenshots: implies --screenshots, sends no text, sets KIT_METADATA_TEXT=0', async () => {
    const r = await run(['release', 'metadata', 'push', 'ios', '--only-screenshots', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      platform: 'ios',
      action: 'push',
      dir: IOS_DIR,
      screenshots: true,
      files: [IOS_SHOT],
      images: [IOS_IMAGE],
      problems: [],
      warnings: [],
      dryRun: false,
      ok: true,
    })
    expect(lanes().map(lane)).toEqual(['ios metadata_push'])
    expect(lanes()[0]!.env).toMatchObject({ KIT_METADATA_SCREENSHOTS: '1', KIT_METADATA_TEXT: '0' })

    const play = await run(['release', 'metadata', 'push', 'android', '--only-screenshots', '-y', '--json'])
    expect(play.code).toBe(0)
    expect(JSON.parse(play.stdout).files).toEqual(ANDROID_IMAGES)
    expect(lanes()[1]!.env).toMatchObject({ KIT_METADATA_SCREENSHOTS: '1', KIT_METADATA_TEXT: '0' })

    const dry = await run(['release', 'metadata', 'push', 'ios', '--only-screenshots', '--dry-run'])
    expect(dry.stdout).toBe(`${IOS_SHOT}\n`)
    expect(dry.stderr).toContain('would push 1 image to the App Store listing of app.example')
    expect(dry.stderr).toContain('replaces every screenshot set of: en-US')
  })

  test('--only-screenshots needs no text files', async () => {
    rmSync(join(f.dir, `${ANDROID_DIR}/en-US/title.txt`))
    rmSync(join(f.dir, `${ANDROID_DIR}/en-US/full_description.txt`))
    const text = await run(['release', 'metadata', 'push', 'android', '--screenshots', '--yes'])
    expect(text.code).toBe(4)
    expect(text.stderr).toContain(`No listing text in ${ANDROID_DIR}`)
    const play = await run([
      'release',
      'metadata',
      'push',
      'android',
      '--only-screenshots',
      '--yes',
      '--json',
    ])
    expect(play.code).toBe(0)
    expect(JSON.parse(play.stdout).files).toEqual(ANDROID_IMAGES)
    expect(lanes().map(lane)).toEqual(['android metadata_push'])
    expect(lanes()[0]!.env.KIT_METADATA_TEXT).toBe('0')
  })

  test('ios --only-screenshots needs no metadata directory: the screenshots sit beside it', async () => {
    rmSync(join(f.dir, IOS_DIR), { recursive: true })
    const text = await run(['release', 'metadata', 'push', 'ios', '--screenshots', '--yes'])
    expect(text.code).toBe(2)
    const r = await run(['release', 'metadata', 'push', 'ios', '--only-screenshots', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).files).toEqual([IOS_SHOT])
    expect(lanes().map(lane)).toEqual(['ios metadata_push'])
    expect(lanes()[0]!.env.KIT_METADATA_TEXT).toBe('0')
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
  const read = (path: string) => readFileSync(join(f.dir, path), 'utf8')
  const same = (path: string, bytes: Uint8Array) => readFileSync(join(f.dir, path)).equals(bytes)

  test('ios: one metadata_pull lane, text only by default; no confirmation', async () => {
    const r = await run(['release', 'metadata', 'pull', 'ios', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      platform: 'ios',
      action: 'pull',
      dir: IOS_DIR,
      screenshots: false,
      dryRun: false,
      ok: true,
      files: IOS_TEXT,
    })
    const calls = lanes()
    expect(calls.map(lane)).toEqual(['ios metadata_pull'])
    const env = calls[0]!.env
    expect(real(env.KIT_METADATA_PATH!)).toBe(real(join(f.dir, IOS_DIR)))
    expect(env).toMatchObject({ KIT_IOS_BUNDLE_ID: 'app.example', ASC_KEY_ID: 'KEYID123' })
    expect(env.KIT_ASC_KEY_PATH).toMatch(/asc-key\.p8$/)
    expect(env.KIT_METADATA_SCREENSHOTS).toBe('0')
    expect(read(`${IOS_DIR}/en-US/name.txt`)).toBe('pulled\n')
    // local screenshots are untouched
    expect(same(IOS_SHOT, IPHONE())).toBe(true)
  })

  test('ios: review_information (App Review contact, demo login) never stays in the repo', async () => {
    // an uncommitted one does not block the pull; whatever deliver writes is removed
    put(`${IOS_DIR}/review_information/demo_user.txt`, 'someone')
    const r = await run(['release', 'metadata', 'pull', 'ios', '--json'])
    expect(r.code).toBe(0)
    expect(lanes().map(lane)).toEqual(['ios metadata_pull'])
    expect(existsSync(join(f.dir, IOS_DIR, 'review_information'))).toBe(false)
    expect(JSON.stringify(JSON.parse(r.stdout).files)).not.toContain('review_information')
  })

  test('ios: review_information is removed even when the lane fails', async () => {
    f.script(
      'bundle',
      'case "$*" in *metadata_pull*) mkdir -p "$KIT_METADATA_PATH/review_information"; echo s3cret > "$KIT_METADATA_PATH/review_information/demo_password.txt"; exit 1 ;; esac; exit 0',
    )
    const r = await run(['release', 'metadata', 'pull', 'ios'])
    expect(r.code).toBe(1)
    expect(existsSync(join(f.dir, IOS_DIR, 'review_information'))).toBe(false)
  })

  test('ios --screenshots: KIT_METADATA_SCREENSHOTS=1 and both directories', async () => {
    const r = await run(['release', 'metadata', 'pull', 'ios', '--screenshots', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      platform: 'ios',
      action: 'pull',
      dir: IOS_DIR,
      screenshots: true,
      screenshotsDir: 'client/fastlane/screenshots',
      dryRun: false,
      ok: true,
      files: [...IOS_TEXT, IOS_SHOT],
    })
    const env = lanes()[0]!.env
    expect(env.KIT_METADATA_SCREENSHOTS).toBe('1')
    expect(real(env.KIT_SCREENSHOTS_PATH!)).toBe(real(join(f.dir, 'client/fastlane/screenshots')))
    expect(read(IOS_SHOT)).toBe('pulled\n')
  })

  test('android: metadata_pull with the Play key, text only by default', async () => {
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
    expect(env.KIT_METADATA_SCREENSHOTS).toBe('0')
    expect(read(`${ANDROID_DIR}/en-US/title.txt`)).toBe('pulled\n')
    expect(same(`${ANDROID_DIR}/en-US/images/icon.png`, png(512, 512, true))).toBe(true)
  })

  test('android --screenshots: KIT_METADATA_SCREENSHOTS=1, images listed', async () => {
    const r = await run(['release', 'metadata', 'pull', 'android', '--screenshots', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({
      screenshots: true,
      ok: true,
      files: [...ANDROID_TEXT, ...ANDROID_IMAGES],
    })
    expect(lanes()[0]!.env.KIT_METADATA_SCREENSHOTS).toBe('1')
    expect(read(`${ANDROID_DIR}/en-US/images/icon.png`)).toBe('pulled\n')
  })

  test('a text pull stays a text pull with KIT_METADATA_SCREENSHOTS=1 inherited', async () => {
    const hostile = { KIT_METADATA_SCREENSHOTS: '1', KIT_METADATA_TEXT: '0' }
    for (const platform of ['ios', 'android']) {
      const r = await run(['release', 'metadata', 'pull', platform, '--json'], hostile)
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout).screenshots).toBe(false)
    }
    expect(lanes().map((c) => c.env.KIT_METADATA_SCREENSHOTS)).toEqual(['0', '0'])
    // the local images are as they were: the fake lanes overwrite them when the switch is on
    expect(same(IOS_SHOT, IPHONE())).toBe(true)
    expect(same(`${ANDROID_DIR}/en-US/images/icon.png`, png(512, 512, true))).toBe(true)
  })

  test('the dirty check covers only what the pull writes', async () => {
    // uncommitted screenshots and images, and Play files inside the iOS metadata dir
    put('client/fastlane/screenshots/en-US/new.png')
    put(`${ANDROID_DIR}/en-US/images/icon.png`, 'edited')
    put(`${ANDROID_DIR}/en-US/images/phoneScreenshots/2_en-US.png`)
    for (const platform of ['ios', 'android']) {
      const text = await run(['release', 'metadata', 'pull', platform])
      expect(text.code).toBe(0)
    }
    expect(read(`${ANDROID_DIR}/en-US/images/icon.png`)).toBe('edited')
    const before = lanes().length

    const ios = await run(['release', 'metadata', 'pull', 'ios', '--screenshots', '--force'])
    expect(ios.code).toBe(0)
    sh(['git', 'add', '-A'])
    sh(['git', 'commit', '-qm', 'chore: listing'])
    put('client/fastlane/screenshots/en-US/newer.png')
    put(`${ANDROID_DIR}/en-US/images/icon.png`, 'edited again')
    const shots = await run(['release', 'metadata', 'pull', 'ios', '--screenshots'])
    expect(shots.code).toBe(4)
    expect(shots.stderr).toContain(`${IOS_DIR} and client/fastlane/screenshots`)
    expect(shots.stderr).toContain('client/fastlane/screenshots/en-US/newer.png')
    expect(shots.stderr).not.toContain('images/icon.png')
    const images = await run(['release', 'metadata', 'pull', 'android', '--screenshots'])
    expect(images.code).toBe(4)
    expect(images.stderr).toContain(`${ANDROID_DIR}/en-US/images/icon.png`)
    expect(lanes().length).toBe(before + 1)
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

  test('a first pull creates the directory', async () => {
    rmSync(join(f.dir, ANDROID_DIR), { recursive: true })
    sh(['git', 'commit', '-qam', 'chore: drop the listing'])
    const r = await run(['release', 'metadata', 'pull', 'android', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).files).toEqual([`${ANDROID_DIR}/en-US/title.txt`])
  })

  test('--dry-run runs nothing', async () => {
    const none = { ASC_KEY_P8_BASE64: '' }
    const r = await run(['release', 'metadata', 'pull', 'ios', '--screenshots', '--dry-run'], none)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(
      `would download the App Store listing text and screenshots of app.example into ${IOS_DIR} and client/fastlane/screenshots`,
    )
    const text = await run(['release', 'metadata', 'pull', 'ios', '--dry-run'], none)
    expect(text.stderr).toContain(
      `would download the App Store listing text of app.example into ${IOS_DIR}\n`,
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

describe('kit release metadata', () => {
  test('the group lists pull and push, with or without --help', async () => {
    for (const args of [
      ['release', 'metadata'],
      ['release', 'metadata', '--help'],
    ]) {
      const r = await run(args)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('kit release metadata <command> [options]')
      expect(r.stdout).toMatch(/pull\s+Download the store listing/)
      expect(r.stdout).toMatch(/push\s+Upload the store listing text/)
    }
    expect(lanes()).toEqual([])
  })
})
