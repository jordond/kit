import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

/**
 * A Kotlin toolchain project whose app module is `mobile/android`, not a child of toolchain.root.
 * The fixture's fake wrapper behaves like the real one: `-m mobile/android` is "Couldn't find
 * module(s) named", `-m android` builds into `build/tasks/_android_*`.
 */

const b64 = (s: string) => Buffer.from(s).toString('base64')
const SECRETS = {
  PLAY_SERVICE_ACCOUNT_BASE64: b64('{"type": "service_account", "private_key": "pk-value"}'),
  ANDROID_KEYSTORE_BASE64: b64('keystore-bytes'),
  ANDROID_KEYSTORE_ALIAS: 'upload',
  ANDROID_KEYSTORE_PASSWORD: 'ks-password-value',
}

interface Logged {
  argv: string[]
  env?: Record<string, string>
  yaml?: string
}

let f: Fixture
let remote: string
const MODULE = 'mobile/android/module.yaml'
const CONFIG = 'kit.config.ts'

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
const kotlin = () => log('.kotlin.log').map((c) => c.argv.join(' '))

const run = (args: string[], env: Record<string, string> = {}) =>
  f.kit(args, { env: { ...SECRETS, GITHUB_ACTIONS: '', KIT_TEST_LOG: join(f.dir, '.kotlin.log'), ...env } })

/** Rewrite `release.android.module` in the fixture's config and commit it. */
function setModule(value: string) {
  const path = join(f.dir, CONFIG)
  writeFileSync(path, readFileSync(path, 'utf8').replace("module: 'mobile/android'", `module: ${value}`))
  sh(['git', 'commit', '-qam', 'chore: module'])
}

beforeEach(() => {
  f = fixture('release-toolchain-nested', ['bundle', 'java', 'ktlint', 'adb'])
  const laneLog = join(f.dir, '.lanes.log')
  writeFileSync(laneLog, '')
  f.script(
    'bundle',
    `bun -e 'const e=process.env;console.log(JSON.stringify({argv:process.argv.slice(1),env:Object.fromEntries(Object.entries(e).filter(([k])=>/^(KIT_|ANDROID_)/.test(k)))}))' -- "$@" >> "${laneLog}"
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
    '.fakebin/\n.calls.log\n.lanes.log\n.kotlin.log\nnode_modules/\nbuild/\n',
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

describe('a nested Kotlin toolchain module', () => {
  test('release: module.yaml is edited at its path, the build gets the basename, the AAB is found', async () => {
    const original = readFileSync(join(f.dir, MODULE), 'utf8')
    const r = await run(['release', 'android', '--track', 'internal', '--json'])
    expect(r.stderr).not.toContain("Couldn't find module")
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ version: '1.4.0', build: 42, uploaded: true })
    expect(doc.artifacts.aab).toEndWith('build/tasks/_android_bundleAndroid/gradle-project-release.aab')

    expect(kotlin()).toEqual(['package -m android'])
    expect(log('.kotlin.log')[0]!.yaml).toContain(
      '    versionName: "1.4.0"\n    versionCode: 42\n    signing:',
    )
    const upload = lanes()[1]!
    expect(upload.env!.KIT_ANDROID_AAB).toBe(doc.artifacts.aab)
    expect(upload.env!.KIT_ANDROID_MODULE).toBe('android')
    expect(upload.env!.KIT_ANDROID_MODULE_DIR).toEndWith('/mobile/android')

    expect(readFileSync(join(f.dir, MODULE), 'utf8')).toBe(original)
    expect(sh(['git', 'status', '--porcelain'])).toBe('')
  })

  test('the AAB is found by the task dir when the output names no path', async () => {
    const wrapper = join(f.dir, 'kotlin')
    writeFileSync(wrapper, readFileSync(wrapper, 'utf8').replace('echo "Build successful"', 'true'))
    sh(['git', 'commit', '-qam', 'chore: quiet wrapper'])
    const r = await run(['release', 'android', '--track', 'internal', '--code', '5', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).artifacts.aab).toEndWith('_android_bundleAndroid/gradle-project-release.aab')
  })

  test('kit build --release and the gates use the same name', async () => {
    const b = await run(['build', 'app', '--release'])
    expect(b.code).toBe(0)
    const r = await run(['release', 'android', '-t', 'beta', '--code', '7', '--yes', '--dry-run'])
    expect(r.code).toBe(0)
    expect(kotlin()).toEqual(['package -m android', 'test -m core', 'package -m android'])
  })

  test('kit app build: -m android, artifact under _android_buildAndroidDebug', async () => {
    const r = await run(['app', 'build', 'android'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toEndWith('build/tasks/_android_buildAndroidDebug/gradle-project-debug.apk')
    expect(kotlin()).toEqual(['build -m android -p android -v debug'])
  })

  test('version bump rewrites the nested module.yaml in the same commit', async () => {
    const r = await run(['version', 'bump', 'minor', '--no-push', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({
      module: MODULE,
      changes: [{ name: 'android', to: '1.5.0' }],
    })
    expect(readFileSync(join(f.dir, MODULE), 'utf8')).toContain('    versionName: "1.5.0"\n')
    expect(sh(['git', 'show', '--name-only', '--format=%s', 'HEAD']).split('\n')).toEqual([
      'chore(release): android 1.5.0',
      '',
      'libs.versions.toml',
      MODULE,
    ])
  })

  test('version drift is read from the nested module.yaml', async () => {
    const path = join(f.dir, MODULE)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"1.4.0"', '"1.3.0"'))
    sh(['git', 'commit', '-qam', 'drift'])
    const r = await run(['release', 'android', '--track', 'internal'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain(`${MODULE} says 1.3.0`)
    expect(lanes()).toEqual([])
  })

  test('{ path, name } states the name when it is not the basename', async () => {
    setModule("{ path: 'mobile/android', name: 'android' }")
    const r = await run(['release', 'android', '--track', 'internal', '--code', '5', '--json'])
    expect(r.code).toBe(0)
    expect(kotlin()).toEqual(['package -m android'])
  })

  test('a module that is not there: the path checked, the name, the key and the listed modules', async () => {
    setModule("'android'")
    for (const args of [
      ['release', 'android', '--track', 'internal', '--code', '5'],
      ['version', 'bump', 'patch', '--no-push'],
      ['app', 'build', 'android'],
    ]) {
      const r = await run(args)
      expect(r.code).toBe(3) // config
      expect(r.stderr).toContain('Kotlin toolchain module not found: android/module.yaml does not exist')
      expect(r.stderr).toContain('Checked android/module.yaml (from release.android.module)')
      expect(r.stderr).toContain('`-m android`')
      expect(r.stderr).toContain('project.yaml lists: mobile/android, mobile/core')
    }
    expect(kotlin()).toEqual([])
    expect(lanes()).toEqual([])
  })
})
