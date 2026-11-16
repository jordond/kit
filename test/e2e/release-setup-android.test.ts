import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

let fx: Fixture
afterEach(() => fx.cleanup())

const read = (p: string) => readFileSync(join(fx.dir, p), 'utf8')
const envValue = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(read('.env'))?.[1] ?? ''
const hasKeytool = !!Bun.which('keytool')

/** gh fake that also records what is piped to `secret set`. */
function recordingGh(): string {
  return `printf '%s\\n' "$(bun -e 'console.log(JSON.stringify({bin:"gh",argv:process.argv.slice(1),cwd:process.cwd()}))' "$@")" >> "${fx.dir}/.calls.log"
if [ "$1" = secret ] && [ "$2" = set ]; then printf '%s=' "$3" >> "${fx.dir}/.stdin.log"; cat >> "${fx.dir}/.stdin.log"; echo >> "${fx.dir}/.stdin.log"; fi
f="${fx.dir}/.fakebin/gh.fail"
if [ -f "$f" ]; then cat "$f.out" 2>/dev/null; exit "$(cat "$f")"; fi`
}

describe.skipIf(!hasKeytool)('release setup android (gradle, keytool)', () => {
  test('creates the keystore, writes .env, prints the password once', async () => {
    fx = fixture('release', ['gh'])
    writeFileSync(join(fx.dir, '.env'), '# app\nOTHER=1\n')
    const r = await fx.kit(['release', 'setup', 'android', '--out', 'keys/upload.jks'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')

    const file = join(fx.dir, 'keys/upload.jks')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(read('.env')).toStartWith('# app\nOTHER=1\n')
    expect(statSync(join(fx.dir, '.env')).mode & 0o777).toBe(0o600)
    expect(envValue('ANDROID_KEYSTORE_ALIAS')).toBe('key0')
    expect(Buffer.from(envValue('ANDROID_KEYSTORE_BASE64'), 'base64').equals(readFileSync(file))).toBe(true)

    const password = envValue('ANDROID_KEYSTORE_PASSWORD')
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(r.stderr.split(password).length - 1).toBe(1)
    expect(r.stderr).toContain('alias     key0')
    expect(r.stderr).toContain('GitHub Actions secrets not set')
    // The fixture module has no build file: the Gradle config note says so.
    expect(r.stderr).toContain('No build.gradle(.kts) in client/android')
    expect(fx.calls()).toEqual([])

    // The password opens the store and the key under that alias.
    const list = Bun.spawnSync(
      ['keytool', '-list', '-keystore', file, '-alias', 'key0', '-storepass:env', 'P'],
      {
        env: { ...process.env, P: password },
      },
    )
    expect(list.exitCode).toBe(0)
    expect(list.stdout.toString()).toContain('PrivateKeyEntry')
  })

  test('defaults to ~/.keystores/<name>.keystore; --alias and --github set the secrets on stdin', async () => {
    fx = fixture('release', ['gh'])
    fx.script('gh', recordingGh())
    const r = await fx.kit(['release', 'setup', 'android', '--alias', 'upload', '--github'], {
      env: { HOME: fx.dir },
    })
    expect(r.code).toBe(0)
    expect(existsSync(join(fx.dir, '.keystores/app.keystore'))).toBe(true)
    expect(fx.calls().map((c) => c.argv.join(' '))).toEqual([
      'secret set ANDROID_KEYSTORE_BASE64',
      'secret set ANDROID_KEYSTORE_ALIAS',
      'secret set ANDROID_KEYSTORE_PASSWORD',
    ])
    expect(read('.stdin.log')).toBe(
      `ANDROID_KEYSTORE_BASE64=${envValue('ANDROID_KEYSTORE_BASE64')}\nANDROID_KEYSTORE_ALIAS=upload\nANDROID_KEYSTORE_PASSWORD=${envValue('ANDROID_KEYSTORE_PASSWORD')}\n`,
    )
    expect(r.stderr).toContain('set GitHub Actions secrets: ANDROID_KEYSTORE_BASE64')
  })

  test('a gh failure keeps the keystore and .env, and exits non-zero', async () => {
    fx = fixture('release', ['gh'])
    fx.fail('gh', 1, 'HTTP 403: Resource not accessible')
    const r = await fx.kit(['release', 'setup', 'android', '--out', 'k.jks', '--github'])
    expect(r.code).not.toBe(0)
    expect(existsSync(join(fx.dir, 'k.jks'))).toBe(true)
    expect(envValue('ANDROID_KEYSTORE_PASSWORD')).not.toBe('')
    expect(r.stderr).toContain('GitHub Actions secrets not fully set')
    expect(r.stderr).toContain(envValue('ANDROID_KEYSTORE_PASSWORD')) // still shown once
  })

  test('--json carries the password; a second run keeps the key, --force replaces it', async () => {
    fx = fixture('release', ['gh'])
    const first = await fx.kit(['release', 'setup', 'android', '--out', 'a.jks', '--json'])
    expect(first.code).toBe(0)
    const doc = JSON.parse(first.stdout)
    expect(doc).toMatchObject({ alias: 'key0', generator: 'keytool', github: false, pushed: [], ok: true })
    expect(doc.password).toBe(envValue('ANDROID_KEYSTORE_PASSWORD'))
    expect(first.stderr).not.toContain(doc.password)

    const again = await fx.kit(['release', 'setup', 'android', '--out', 'b.jks'])
    expect(again.code).toBe(0)
    expect(again.stderr).toContain('upload key already in .env; kept')
    expect(existsSync(join(fx.dir, 'b.jks'))).toBe(false)
    expect(envValue('ANDROID_KEYSTORE_PASSWORD')).toBe(doc.password)

    const same = await fx.kit(['release', 'setup', 'android', '--out', 'a.jks', '--force'])
    expect(same.code).toBe(2)
    expect(same.stderr).toContain('already exists')

    const forced = await fx.kit(['release', 'setup', 'android', '--out', 'b.jks', '--force'])
    expect(forced.code).toBe(0)
    expect(envValue('ANDROID_KEYSTORE_PASSWORD')).not.toBe(doc.password)
  })

  test('--play-json stores the service account; --github pushes every Android secret .env holds', async () => {
    fx = fixture('release', ['gh'])
    expect((await fx.kit(['release', 'setup', 'android', '--out', 'a.jks'])).code).toBe(0)
    const password = envValue('ANDROID_KEYSTORE_PASSWORD')
    const json = '{ "type": "service_account", "client_email": "x@y.iam" }'
    writeFileSync(join(fx.dir, 'play.json'), json)

    const r = await fx.kit(['release', 'setup', 'android', '--play-json', 'play.json', '--github'])
    expect(r.code).toBe(0)
    expect(envValue('PLAY_SERVICE_ACCOUNT_BASE64')).toBe(Buffer.from(json).toString('base64'))
    expect(envValue('ANDROID_KEYSTORE_PASSWORD')).toBe(password)
    expect(r.stderr).not.toContain(password)
    expect(r.stderr).toContain('wrote PLAY_SERVICE_ACCOUNT_BASE64 to .env')
    expect(fx.calls().map((c) => c.argv.join(' '))).toEqual([
      'secret set ANDROID_KEYSTORE_BASE64',
      'secret set ANDROID_KEYSTORE_ALIAS',
      'secret set ANDROID_KEYSTORE_PASSWORD',
      'secret set PLAY_SERVICE_ACCOUNT_BASE64',
    ])

    writeFileSync(join(fx.dir, 'bad.json'), '{ "type": "authorized_user" }')
    const bad = await fx.kit(['release', 'setup', 'android', '--play-json', 'bad.json'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('is not a Google service-account JSON')
  })

  test('does not ask about GitHub when it already has every secret and none changed', async () => {
    fx = fixture('release', ['gh'])
    expect((await fx.kit(['release', 'setup', 'android', '--out', 'a.jks'])).code).toBe(0)
    const listing = (names: string[]) =>
      fx.script(
        'gh',
        `${recordingGh()}\nif [ "$1" = secret ] && [ "$2" = list ]; then echo '${JSON.stringify(names.map((name) => ({ name })))}'; fi`,
      )
    const sets = () => fx.calls().filter((c) => c.argv[1] === 'set').length

    listing(['OTHER', 'ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_ALIAS', 'ANDROID_KEYSTORE_PASSWORD'])
    const kept = await fx.kit(['release', 'setup', 'android', '--yes'])
    expect(kept.code).toBe(0)
    expect(kept.stderr).toContain('GitHub Actions secrets already set (--github sets them again)')
    expect(sets()).toBe(0)

    // A value this run writes is not on GitHub yet, whatever the names say.
    writeFileSync(join(fx.dir, 'play.json'), '{ "type": "service_account" }')
    listing([
      'ANDROID_KEYSTORE_BASE64',
      'ANDROID_KEYSTORE_ALIAS',
      'ANDROID_KEYSTORE_PASSWORD',
      'PLAY_SERVICE_ACCOUNT_BASE64',
    ])
    expect((await fx.kit(['release', 'setup', 'android', '--play-json', 'play.json', '--yes'])).code).toBe(0)
    expect(sets()).toBe(4)

    // A name GitHub lacks: asked (--yes answers), and every secret is set.
    listing(['ANDROID_KEYSTORE_BASE64'])
    const missing = await fx.kit(['release', 'setup', 'android', '--yes'])
    expect(missing.stderr).toContain('set GitHub Actions secrets: ANDROID_KEYSTORE_BASE64')
    expect(sets()).toBe(8)
  })

  test('applies the kit release plugin to the app module build file, once', async () => {
    fx = fixture('release', ['gh'])
    const build = 'client/android/build.gradle.kts'
    mkdirSync(join(fx.dir, 'client/android'), { recursive: true })
    writeFileSync(join(fx.dir, 'client/settings.gradle.kts'), 'plugins { id("dev.jordond.kit.settings") }\n')
    writeFileSync(join(fx.dir, build), 'plugins {\n  alias(libs.plugins.kit.release)\n}\n')
    const r = await fx.kit(['release', 'setup', 'android', '--out', 'a.jks'])
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('build.gradle')

    const source =
      'plugins {\n  id("com.android.application")\n}\n\nandroid {\n  namespace = "app.example"\n}\n'
    writeFileSync(join(fx.dir, build), source)
    const dry = await fx.kit(['release', 'setup', 'android', '--dry-run', '--json'])
    expect(JSON.parse(dry.stdout).plugin).toBe(build)
    expect(read(build)).toBe(source)

    const applied = await fx.kit(['release', 'setup', 'android'])
    expect(applied.code).toBe(0)
    expect(applied.stderr).toContain(`apply the kit release plugin in ${build}`)
    expect(applied.stderr).not.toContain('settings.gradle')
    const edited = source.replace('}\n', '  id("dev.jordond.kit.release")\n}\n')
    expect(read(build)).toBe(edited)

    const again = await fx.kit(['release', 'setup', 'android'])
    expect(again.stderr).not.toContain('build.gradle')
    expect(read(build)).toBe(edited)
  })

  test('notes a build file it cannot edit, and settings that do not resolve kit plugins', async () => {
    fx = fixture('release', ['gh'])
    const build = 'client/android/build.gradle'
    mkdirSync(join(fx.dir, 'client/android'), { recursive: true })
    writeFileSync(join(fx.dir, build), "apply plugin: 'com.android.application'\n")
    const none = await fx.kit(['release', 'setup', 'android', '--out', 'a.jks'])
    expect(none.code).toBe(0)
    expect(none.stderr).toContain(`${build} does not apply the kit release plugin and has no plugins block`)
    expect(read(build)).toBe("apply plugin: 'com.android.application'\n")

    writeFileSync(join(fx.dir, build), "plugins {\n    id 'com.android.application'\n}\n")
    const groovy = await fx.kit(['release', 'setup', 'android'])
    expect(read(build)).toBe(
      "plugins {\n    id 'com.android.application'\n    id 'dev.jordond.kit.release'\n}\n",
    )
    expect(groovy.stderr).toContain('settings.gradle(.kts) does not resolve dev.jordond.kit plugins')
  })
})

describe('release setup android', () => {
  test('--dry-run plans and writes nothing', async () => {
    fx = fixture('release', ['gh'])
    const r = await fx.kit([
      'release',
      'setup',
      'android',
      '--out',
      'a.jks',
      '--github',
      '--dry-run',
      '--json',
    ])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.keystore).toEndWith('/a.jks')
    expect(doc).toMatchObject({
      alias: 'key0',
      generator: 'keytool',
      github: true,
      dryRun: true,
    })
    expect(existsSync(join(fx.dir, 'a.jks'))).toBe(false)
    expect(existsSync(join(fx.dir, '.env'))).toBe(false)
    expect(fx.calls()).toEqual([])
  })

  test('toolchain: runs ./kotlin tool generate-keystore with a 0600 properties file, no password on argv', async () => {
    fx = fixture('release-toolchain', ['gh'])
    writeFileSync(
      join(fx.dir, 'kotlin'),
      `#!/bin/sh
bun -e 'const fs = require("fs")
const argv = process.argv.slice(1)
const props = fs.readFileSync(argv[argv.indexOf("--properties-file") + 1], "utf8")
const mode = (fs.statSync(argv[argv.indexOf("--properties-file") + 1]).mode & 0o777).toString(8)
fs.writeFileSync(props.match(/^storeFile=(.*)$/m)[1], "keystore-bytes")
fs.writeFileSync("kotlin.log", JSON.stringify({ argv, props, mode }))' -- "$@"
`,
    )
    chmodSync(join(fx.dir, 'kotlin'), 0o755)
    Bun.spawnSync(['git', 'init', '-q'], { cwd: fx.dir })
    const yaml = read('androidApp/module.yaml')
    const dry = await fx.kit(['release', 'setup', 'android', '--dry-run', '--json'], {
      env: { HOME: fx.dir },
    })
    expect(JSON.parse(dry.stdout)).toMatchObject({ signing: 'androidApp/module.yaml', plugin: null })
    expect(read('androidApp/module.yaml')).toBe(yaml)

    const r = await fx.kit(['release', 'setup', 'android'], { env: { HOME: fx.dir } })
    expect(r.code).toBe(0)
    // module.yaml names a properties file beside it; that file holds this machine's key and is ignored.
    const signed = `${yaml.trimEnd()}\n    signing:\n      enabled: true\n      propertiesFile: ./keystore.properties\n`
    expect(read('androidApp/module.yaml')).toBe(signed)
    expect(r.stderr).toContain('enable Android signing in androidApp/module.yaml')
    expect(r.stderr).toContain('wrote androidApp/keystore.properties and added it to .gitignore')
    expect(statSync(join(fx.dir, 'androidApp/keystore.properties')).mode & 0o777).toBe(0o600)
    expect(read('androidApp/keystore.properties')).toContain(
      `keyAlias=key0\nkeyPassword=${envValue('ANDROID_KEYSTORE_PASSWORD')}\n`,
    )
    expect(read('.gitignore')).toEndWith('keystore.properties\n')
    const again = await fx.kit(['release', 'setup', 'android'], { env: { HOME: fx.dir } })
    expect(again.stderr).not.toContain('module.yaml')
    expect(again.stderr).not.toContain('keystore.properties')
    expect(read('androidApp/module.yaml')).toBe(signed)
    const file = join(fx.dir, '.keystores/app.keystore')
    const password = envValue('ANDROID_KEYSTORE_PASSWORD')
    const log = JSON.parse(read('kotlin.log')) as { argv: string[]; props: string; mode: string }
    expect(log.argv.slice(0, 3)).toEqual(['tool', 'generate-keystore', '--properties-file'])
    expect(log.argv.slice(4)).toEqual(['--dn', 'CN=App'])
    expect(log.argv.join(' ')).not.toContain(password)
    expect(log.mode).toBe('600')
    expect(log.props.replace(/^\/private/gm, '')).toContain(`storeFile=${file.replace(/^\/private/, '')}`)
    expect(log.props).toContain(`keyAlias=key0\nkeyPassword=${password}\n`)
    expect(envValue('ANDROID_KEYSTORE_BASE64')).toBe(Buffer.from('keystore-bytes').toString('base64'))
    // The properties file lived in kit's temp dir and is gone.
    expect(existsSync(log.argv[3]!)).toBe(false)
    expect(r.stderr).not.toContain('build.gradle')
  })

  test('a half-filled upload key in .env is an error, not a new key', async () => {
    fx = fixture('release', ['gh'])
    writeFileSync(join(fx.dir, '.env'), 'ANDROID_KEYSTORE_ALIAS=upload\n')
    const r = await fx.kit(['release', 'setup', 'android', '--out', 'a.jks'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('.env holds ANDROID_KEYSTORE_ALIAS but not ANDROID_KEYSTORE_BASE64')
    expect(existsSync(join(fx.dir, 'a.jks'))).toBe(false)
  })

  test('needs release.android', async () => {
    fx = fixture('infra', [])
    const r = await fx.kit(['release', 'setup', 'android'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('No release.android in kit.config.ts')
  })
})
