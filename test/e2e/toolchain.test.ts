import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

/** Kotlin toolchain (Amper) app: Android built by `./kotlin package`, no Gradle. */

const b64 = (s: string) => Buffer.from(s).toString('base64')
const SECRETS = {
  PLAY_SERVICE_ACCOUNT_BASE64: b64('{"type": "service_account", "private_key": "pk-value"}'),
  ANDROID_KEYSTORE_BASE64: b64('keystore-bytes'),
  ANDROID_KEYSTORE_ALIAS: 'upload',
  ANDROID_KEYSTORE_PASSWORD: 'ks-password-value',
}

interface Logged {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  yaml?: string
  props?: string | null
}

let f: Fixture
let remote: string
const MODULE = 'androidApp/module.yaml'

function sh(cmd: string[], cwd = f.dir) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const log = (name: string): Logged[] =>
  existsSync(join(f.dir, name))
    ? readFileSync(join(f.dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Logged)
    : []
const lanes = () => log('.lanes.log').filter((c) => c.argv[0] === 'exec')
const kotlin = () => log('.kotlin.log')

const run = (args: string[], env: Record<string, string> = {}) =>
  f.kit(args, { env: { ...SECRETS, GITHUB_ACTIONS: '', KIT_TEST_LOG: join(f.dir, '.kotlin.log'), ...env } })

beforeEach(() => {
  f = fixture('release-toolchain', ['bundle', 'java', 'ktlint'])
  const laneLog = join(f.dir, '.lanes.log')
  writeFileSync(laneLog, '')
  f.script(
    'bundle',
    `bun -e 'const e=process.env;console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),env:Object.fromEntries(Object.entries(e).filter(([k])=>/^(KIT_|ANDROID_)/.test(k)))}))' -- "$@" >> "${laneLog}"
case "$*" in
  *"android next_code"*) echo "KIT_NEXT_CODE=42" ;;
esac
exit 0`,
  )
  sh(['git', 'init', '-q', '-b', 'main'])
  sh(['git', 'config', 'user.email', 't@example.com'])
  sh(['git', 'config', 'user.name', 'T'])
  writeFileSync(
    join(f.dir, '.gitignore'),
    '.fakebin/\n.calls.log\n.lanes.log\n.kotlin.log\n.kotlin-fail\nnode_modules/\nbuild/\n',
  )
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

describe('kit release android (Kotlin toolchain)', () => {
  test('internal: next_code → kotlin package with release values → upload_play; module.yaml restored', async () => {
    const original = readFileSync(join(f.dir, MODULE), 'utf8')
    const r = await run(['release', 'android', '--track', 'internal', '--json'])
    expect(r.stderr).not.toContain('java')
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ version: '1.4.0', build: 42, uploaded: true, tag: 'android/v1.4.0+42' })
    expect(doc.artifacts.aab).toEndWith('build/tasks/_androidApp_bundleAndroid/gradle-project-release.aab')

    expect(lanes().map((c) => c.argv.slice(2).join(' '))).toEqual([
      'android next_code',
      'android upload_play',
    ])
    expect(lanes()[1]!.env!.KIT_ANDROID_AAB).toBe(doc.artifacts.aab)

    const [pkg] = kotlin()
    expect(pkg!.argv).toEqual(['package', '-m', 'androidApp'])
    expect(pkg!.yaml).toContain(
      '    versionName: "1.4.0"\n    versionCode: 42\n    signing:\n      enabled: true\n',
    )
    expect(pkg!.props).toMatch(
      /^storeFile=\/.*release\.keystore\nstorePassword=ks-password-value\nkeyAlias=upload\nkeyPassword=ks-password-value\n$/,
    )
    // restored, and nothing else in the tree changed
    expect(readFileSync(join(f.dir, MODULE), 'utf8')).toBe(original)
    expect(sh(['git', 'status', '--porcelain'])).toBe('')
    // passwords never reach the output
    expect(r.stderr).not.toContain('ks-password-value')
  })

  test('a failed build restores module.yaml and uploads nothing', async () => {
    writeFileSync(join(f.dir, '.kotlin-fail'), '')
    const r = await run(['release', 'android', '--track', 'internal', '--code', '5'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('compilation failed')
    expect(lanes()).toEqual([])
    expect(sh(['git', 'status', '--porcelain'])).toBe('')
    expect(sh(['git', 'tag'])).toBe('')
  })

  test('gates run through the wrapper', async () => {
    const r = await run(['release', 'android', '-t', 'beta', '--code', '7', '--yes', '--dry-run'])
    expect(r.code).toBe(0)
    expect(kotlin().map((c) => c.argv.join(' '))).toEqual(['test -m shared', 'package -m androidApp'])
  })

  test('module.yaml versionName drift → exit 4 before any lane', async () => {
    const path = join(f.dir, MODULE)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"1.4.0"', '"1.3.0"'))
    sh(['git', 'commit', '-qam', 'drift'])
    const r = await run(['release', 'android', '--track', 'internal'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('Android version drift')
    expect(lanes()).toEqual([])
  })
})

test('kit version bump rewrites the TOML and versionName in one commit', async () => {
  const r = await run(['version', 'bump', 'minor', '--no-push', '--json'])
  expect(r.code).toBe(0)
  expect(JSON.parse(r.stdout)).toMatchObject({ module: MODULE, changes: [{ name: 'android', to: '1.5.0' }] })
  expect(readFileSync(join(f.dir, 'libs.versions.toml'), 'utf8')).toContain('app-android-version = "1.5.0"')
  expect(readFileSync(join(f.dir, MODULE), 'utf8')).toContain('    versionName: "1.5.0"\n')
  expect(sh(['git', 'show', '--name-only', '--format=%s', 'HEAD']).split('\n')).toEqual([
    'chore(release): android 1.5.0',
    '',
    MODULE,
    'libs.versions.toml',
  ])
})

test('kit test / build --release / kotlin passthrough run the wrapper', async () => {
  expect((await run(['test'])).code).toBe(0)
  expect((await run(['build', 'app', '--release'])).code).toBe(0)
  expect((await run(['kotlin', 'show', 'modules'])).code).toBe(0)
  expect(kotlin().map((c) => c.argv.join(' '))).toEqual(['test', 'package -m androidApp', 'show modules'])
})

test('kit doctor: toolchain pinned, versions agree, java not required', async () => {
  f.fail('java', 1, 'Unable to locate a Java Runtime')
  const r = await run(['doctor', '--json'])
  const checks = JSON.parse(r.stdout).checks as { id: string; status: string; detail?: string }[]
  const by = (id: string) => checks.find((c) => c.id === id)
  expect(by('toolchain')).toMatchObject({ status: 'ok', detail: '0.13.0' })
  expect(by('android-version')).toMatchObject({ status: 'ok' })
  expect(by('java')?.status).toBe('warn')
  expect(by('android-sdk')?.status).not.toBe('fail')
})

test('kit lint / lint --fix run ktlint; doctor requires it', async () => {
  expect((await run(['lint'])).code).toBe(0)
  expect((await run(['lint', '--fix'])).code).toBe(0)
  const calls = f.calls().filter((c) => c.bin === 'ktlint')
  expect(calls.map((c) => c.argv.slice(0, 2).join(' '))).toEqual(['--relative **/*.kt', '--relative -F'])
  f.fail('ktlint', 1, 'androidApp/src/Main.kt:1:1: Unused import (standard:no-unused-imports)')
  const bad = await run(['lint'])
  expect(bad.code).toBe(1)
  expect(bad.stderr).toContain('no-unused-imports')
  expect(bad.stderr).toContain('kit lint --fix')
})

test('kit installed in .kit: doctor reads the pin from .kit/package.json', async () => {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(f.dir, '.github/workflows'), { recursive: true })
  writeFileSync(
    join(f.dir, '.github/workflows/ci.yml'),
    'jobs:\n  a:\n    steps:\n      - uses: jordond/kit/.github/actions/setup@abc123 # v1.2.3\n',
  )
  const r = await run(['doctor', '--json'])
  const checks = JSON.parse(r.stdout).checks as { id: string; status: string; detail?: string }[]
  expect(checks.find((c) => c.id === 'ci-pin')).toMatchObject({ status: 'ok', detail: '1.2.3' })
})
