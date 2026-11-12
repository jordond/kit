import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit app …`: fake gradlew/kotlin write the artifact, fake adb/xcrun/bundletool record the calls. */

const PIXEL = 'emulator-5554 device product:sdk model:Pixel_8 device:emu'
const SIM = 'SIM-UDID-1'

let f: Fixture
afterEach(() => f?.cleanup())

/** The kit environment: one log every fake appends to, and the adb devices it reports. */
const env = (devices: string[] = [PIXEL]) => ({
  KIT_TEST_LOG: join(f.dir, '.app.log'),
  KIT_ADB_DEVICES: devices.join('\\n'),
})
const log = (): string[] =>
  existsSync(join(f.dir, '.app.log'))
    ? readFileSync(join(f.dir, '.app.log'), 'utf8').split('\n').filter(Boolean)
    : []
/** Calls other than the adb/xcrun device probes. */
const acts = () => log().filter((l) => !/^(adb devices|xcrun simctl list)/.test(l))

function setup(name: 'app-gradle' | 'app-toolchain') {
  f = fixture(name, ['adb', 'xcrun', 'xcodebuild', 'bundletool'])
  f.script(
    'adb',
    `echo "adb $*" >> "$KIT_TEST_LOG"
if [ "$1" = devices ]; then printf 'List of devices attached\\n'; [ -n "$KIT_ADB_DEVICES" ] && printf "$KIT_ADB_DEVICES\\n"; fi
exit 0`,
  )
  f.script('bundletool', `echo "bundletool $*" >> "$KIT_TEST_LOG"`)
  f.script(
    'xcrun',
    `echo "xcrun $*" >> "$KIT_TEST_LOG"
case "$*" in
  "simctl list devices -j") echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-1":[{"udid":"${SIM}","name":"iPhone 17","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"x"}]}}' ;;
  "simctl get_app_container"*) echo "$KIT_DATA_DIR" ;;
esac
exit 0`,
  )
  f.script(
    'xcodebuild',
    `echo "xcodebuild $*" >> "$KIT_TEST_LOG"
mkdir -p client/ios/build/kit/Build/Products/Debug-iphonesimulator/iosApp.app`,
  )
}

const apk = () => join(f.dir, 'client/android/build/outputs/apk/debug/app-debug.apk')

describe('kit app (gradle)', () => {
  test('build prints the artifact path alone on stdout', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'build', 'android'], { env: env() })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toMatch(/client\/android\/build\/outputs\/apk\/debug\/app-debug\.apk$/)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(log()).toEqual(['gradlew :android:assembleDebug'])
  })

  test('build --release and --json', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'build', 'android', '--release', '--json'], { env: env() })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.platform).toBe('android')
    expect(doc.artifact).toMatch(/apk\/release\/app-release\.apk$/)
    expect(doc.cmd).toEqual(['./gradlew', ':android:assembleRelease'])
  })

  test('build --dry-run --json plans and runs nothing', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'build', 'android', '--dry-run', '--json'], { env: env() })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.plan).toEqual([['./gradlew', ':android:assembleDebug']])
    expect(doc.artifactDir).toMatch(/client\/android\/build\/outputs\/apk\/debug$/)
    expect(log()).toEqual([])
  })

  test('build rejects ipad and an unknown platform with exit 2', async () => {
    setup('app-gradle')
    expect((await f.kit(['app', 'build', 'ipad'], { env: env() })).code).toBe(2)
    expect((await f.kit(['app', 'build'], { env: env() })).code).toBe(2)
  })

  test('install builds, then adb installs the apk on the only device', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'install', 'android'], { env: env() })
    expect(r.code).toBe(0)
    expect(acts()).toHaveLength(2)
    expect(acts()[0]).toBe('gradlew :android:assembleDebug')
    expect(acts()[1]).toMatch(
      /^adb -s emulator-5554 install -r .*client\/android\/build\/outputs\/apk\/debug\/app-debug\.apk$/,
    )
  })

  test('run installs then launches with monkey', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'run', 'android'], { env: env() })
    expect(r.code).toBe(0)
    expect(acts().at(-1)).toBe(
      'adb -s emulator-5554 shell monkey -p app.example -c android.intent.category.LAUNCHER 1',
    )
  })

  test('install --file skips the build; an aab goes through bundletool', async () => {
    setup('app-gradle')
    writeFileSync(join(f.dir, 'my.apk'), 'x')
    writeFileSync(join(f.dir, 'my.aab'), 'x')
    expect((await f.kit(['app', 'install', 'android', '--file', 'my.apk'], { env: env() })).code).toBe(0)
    expect(acts()).toHaveLength(1)
    expect(acts()[0]).toMatch(/^adb -s emulator-5554 install -r .*my\.apk$/)
    expect((await f.kit(['app', 'install', 'android', '--file', 'my.aab'], { env: env() })).code).toBe(0)
    const tool = acts().filter((l) => l.startsWith('bundletool'))
    expect(tool[0]).toMatch(
      /^bundletool build-apks --connected-device --device-id=emulator-5554 --bundle=.*my\.aab --output=.*app\.apks --overwrite$/,
    )
    expect(tool[1]).toMatch(/^bundletool install-apks --apks=.*app\.apks --device-id=emulator-5554$/)
    expect(acts().some((l) => l.startsWith('gradlew'))).toBe(false)
  })

  test('install --file with a missing file is a usage error', async () => {
    setup('app-gradle')
    expect((await f.kit(['app', 'install', 'android', '--file', 'nope.apk'], { env: env() })).code).toBe(2)
  })

  test('--no-build installs the newest existing artifact, or fails with a hint', async () => {
    setup('app-gradle')
    const none = await f.kit(['app', 'install', 'android', '--no-build'], { env: env() })
    expect(none.code).toBe(4)
    expect(none.stderr).toContain('kit app build android')
    mkdirSync(join(f.dir, 'client/android/build/outputs/apk/debug'), { recursive: true })
    writeFileSync(apk(), 'x')
    const ok = await f.kit(['app', 'install', 'android', '--no-build'], { env: env() })
    expect(ok.code).toBe(0)
    expect(acts().some((l) => l.startsWith('gradlew'))).toBe(false)
    expect(acts().at(-1)).toMatch(/^adb -s emulator-5554 install -r .*app-debug\.apk$/)
  })

  test('--device skips discovery', async () => {
    setup('app-gradle')
    await f.kit(['app', 'install', 'android', '--device', 'serial-9'], { env: env([]) })
    expect(log().some((l) => l.startsWith('adb devices'))).toBe(false)
    expect(acts().at(-1)).toMatch(/^adb -s serial-9 install -r /)
  })

  test('several devices in CI without --device is a usage error', async () => {
    setup('app-gradle')
    const two = [PIXEL, 'emulator-5556 device product:sdk model:Pixel_9 device:emu']
    const r = await f.kit(['app', 'install', 'android'], { env: env(two) })
    expect(r.code).toBe(2)
    expect(acts().some((l) => l.startsWith('gradlew'))).toBe(false)
  })

  test('install --dry-run --json prints the plan and mutates nothing', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'install', 'android', '--dry-run', '--json'], { env: env() })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.device).toBe('emulator-5554')
    expect(doc.plan[0]).toEqual(['./gradlew', ':android:assembleDebug'])
    expect(doc.plan[1].slice(1, 5)).toEqual(['-s', 'emulator-5554', 'install', '-r'])
    expect(acts()).toEqual([])
  })

  test('uninstall and clear use adb on the running device', async () => {
    setup('app-gradle')
    expect((await f.kit(['app', 'uninstall', 'android'], { env: env() })).code).toBe(0)
    expect((await f.kit(['app', 'clear', 'android'], { env: env() })).code).toBe(0)
    expect(acts()).toEqual([
      'adb -s emulator-5554 uninstall app.example',
      'adb -s emulator-5554 shell pm clear app.example',
    ])
  })

  test('uninstall and clear with no device running exit 4 and name `kit device boot`', async () => {
    setup('app-gradle')
    for (const verb of ['uninstall', 'clear']) {
      const r = await f.kit(['app', verb, 'android'], { env: env([]) })
      expect(r.code).toBe(4)
      expect(r.stderr).toContain('kit device boot android')
    }
  })

  test('clear --dry-run --json mutates nothing', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'clear', 'android', '--dry-run', '--json'], { env: env() })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).plan[0].slice(-4)).toEqual(['shell', 'pm', 'clear', 'app.example'])
    expect(acts()).toEqual([])
  })
})

describe('kit app (toolchain)', () => {
  test('build runs ./kotlin build and prints the apk', async () => {
    setup('app-toolchain')
    const r = await f.kit(['app', 'build', 'android'], { env: env() })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toMatch(/build\/tasks\/_androidApp_buildAndroidDebug\/gradle-project-debug\.apk$/)
    expect(log()).toEqual(['kotlin build -m androidApp -p android -v debug'])
  })

  test('a build that leaves no artifact fails naming the directory searched', async () => {
    setup('app-toolchain')
    writeFileSync(join(f.dir, 'kotlin'), '#!/bin/sh\nexit 0\n')
    const r = await f.kit(['app', 'build', 'android'], { env: env() })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('_androidApp_buildAndroidDebug')
  })

  test('run builds, installs and launches', async () => {
    setup('app-toolchain')
    const r = await f.kit(['app', 'run', 'android'], { env: env() })
    expect(r.code).toBe(0)
    expect(acts()[0]).toBe('kotlin build -m androidApp -p android -v debug')
    expect(acts()[1]).toMatch(/^adb -s emulator-5554 install -r .*gradle-project-debug\.apk$/)
    expect(acts()[2]).toContain('monkey -p app.example')
  })
})

describe.if(process.platform === 'darwin')('kit app ios (simulator)', () => {
  test('gradle repo: xcodebuild then simctl install and launch', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'run', 'ios'], { env: env() })
    expect(r.code).toBe(0)
    expect(acts()[0]).toContain(
      `xcodebuild -project client/ios/iosApp.xcodeproj -scheme iosApp -configuration Debug -destination platform=iOS Simulator,id=${SIM}`,
    )
    expect(acts()[1]).toMatch(new RegExp(`^xcrun simctl install ${SIM} .*iosApp\\.app$`))
    expect(acts()[2]).toBe(`xcrun simctl launch ${SIM} app.example`)
  })

  test('physical device without --file is a usage error', async () => {
    setup('app-gradle')
    const r = await f.kit(['app', 'install', 'ios', '--device', 'PHYS-1'], { env: env() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--file')
  })

  test('physical device with --file uses devicectl', async () => {
    setup('app-gradle')
    mkdirSync(join(f.dir, 'dev.app'))
    const r = await f.kit(['app', 'install', 'ios', '--device', 'PHYS-1', '--file', 'dev.app'], {
      env: env(),
    })
    expect(r.code).toBe(0)
    expect(acts().at(-1)).toMatch(/^xcrun devicectl device install app --device PHYS-1 .*dev\.app$/)
  })

  test('uninstall and clear (terminate, container, wipe)', async () => {
    setup('app-gradle')
    // clear refuses anything that is not this simulator's app data container.
    const data = join(f.dir, 'CoreSimulator/Devices', SIM, 'data/Containers/Data/Application/APP-1')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'state.db'), 'x')
    expect((await f.kit(['app', 'uninstall', 'ios'], { env: env() })).code).toBe(0)
    expect(acts().at(-1)).toBe(`xcrun simctl uninstall ${SIM} app.example`)
    expect((await f.kit(['app', 'clear', 'ios'], { env: { ...env(), KIT_DATA_DIR: data } })).code).toBe(0)
    expect(acts().slice(-2)).toEqual([
      `xcrun simctl terminate ${SIM} app.example`,
      `xcrun simctl get_app_container ${SIM} app.example data`,
    ])
    expect(existsSync(join(data, 'state.db'))).toBe(false)
  })
})
