import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

let f: Fixture
let avdHome: string

/** Fakes log plain `bin argv...` lines here; the fixture's own JSON log is only for the default fakes. */
const argv = (): string[] => {
  try {
    return readFileSync(join(f.dir, '.argv.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** A fake that records `<bin> <args>` and runs `body` (sh) with `$*` as the argument string. */
const fake = (bin: string, body: string): void =>
  f.script(bin, `echo "${bin} $*" >> "${join(f.dir, '.argv.log')}"\nUP="${join(f.dir, '.up')}"\n${body}`)

const adbFake = `
case "$*" in
  "devices -l")
    echo "List of devices attached"
    [ -f "$UP" ] && echo "emulator-5554          device product:sdk_gphone64 model:sdk_gphone64_arm64 device:emu64a"
    exit 0;;
  "-s emulator-5554 emu avd name") echo Pixel_Test; echo OK; exit 0;;
  *getprop*) echo 1; exit 0;;
esac
exit 0`

const emulatorFake = `
case "$1" in
  -list-avds) echo Pixel_Test; echo Spare_AVD;;
  -avd) touch "$UP";;
esac
exit 0`

const avdmanagerFake = `
case "$*" in
  "list device -c") printf 'pixel_9\\npixel_10_pro_xl\\nwear_round\\n';;
esac
exit 0`

const run = (args: string[], env: Record<string, string> = {}) =>
  f.kit(args, { env: { ANDROID_AVD_HOME: avdHome, KIT_DEVICE_TIMEOUT_MS: '20000', ...env } })

beforeEach(() => {
  f = fixture('devices', [])
  avdHome = mkdtempSync(join(tmpdir(), 'kit-avd-'))
  mkdirSync(join(avdHome, 'Pixel_Test.avd'))
  writeFileSync(join(avdHome, 'Pixel_Test.avd', 'config.ini'), 'hw.device.name=pixel_10_pro_xl\n')
  fake('adb', adbFake)
  fake('emulator', emulatorFake)
  fake('avdmanager', avdmanagerFake)
})

afterEach(() => {
  f.cleanup()
  rmSync(avdHome, { recursive: true, force: true })
})

describe('kit device list (android)', () => {
  test('--json lists the running emulator and the shutdown AVD', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    const r = await run(['device', 'list', 'android', '--json'])
    expect(r.code).toBe(0)
    const { devices } = JSON.parse(r.stdout)
    expect(devices).toEqual([
      {
        id: 'emulator-5554',
        name: 'Pixel_Test',
        platform: 'android',
        kind: 'emulator',
        state: 'booted',
        target: 'android',
      },
      {
        id: 'Spare_AVD',
        name: 'Spare_AVD',
        platform: 'android',
        kind: 'emulator',
        state: 'shutdown',
        target: 'android',
      },
    ])
  })

  test('--booted drops the shutdown AVD', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    const r = await run(['device', 'list', 'android', '--booted', '--json'])
    expect(JSON.parse(r.stdout).devices.map((d: { id: string }) => d.id)).toEqual(['emulator-5554'])
  })

  test('human output goes to stderr, booted first', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    const r = await run(['device', 'list', 'android'])
    expect(r.stdout).toBe('')
    expect(r.stderr.indexOf('● booted')).toBeGreaterThanOrEqual(0)
    expect(r.stderr.indexOf('● booted')).toBeLessThan(r.stderr.indexOf('○ shutdown'))
  })

  test('an unknown platform is a usage error', async () => {
    expect((await run(['device', 'list', 'watch'])).code).toBe(2)
  })
})

describe('kit device boot (android)', () => {
  test('boots an existing AVD with --yes and reports the serial', async () => {
    const r = await run(['device', 'boot', 'android', '--device', 'Pixel_Test', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ target: 'android', id: 'emulator-5554', booted: true })
    expect(argv().some((l) => l.startsWith('emulator -avd Pixel_Test'))).toBe(true)
  })

  test('without --device it boots the AVD built from the newest Pixel', async () => {
    const r = await run(['device', 'boot', 'android', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).id).toBe('emulator-5554')
    expect(argv().some((l) => l.startsWith('emulator -avd Pixel_Test'))).toBe(true)
  })

  test('reports a running device instead of booting another', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    const r = await run(['device', 'boot', 'android', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ target: 'android', id: 'emulator-5554', booted: true })
    expect(argv().some((l) => l.startsWith('emulator -avd'))).toBe(false)
  })

  test('--dry-run boots nothing', async () => {
    const r = await run(['device', 'boot', 'android', '--yes', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ target: 'android', id: 'Pixel_Test', booted: false })
    expect(argv().some((l) => l.startsWith('emulator -avd'))).toBe(false)
  })

  test('without --yes in CI it refuses to confirm (exit 2)', async () => {
    const r = await run(['device', 'boot', 'android'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--yes')
    expect(argv().some((l) => l.startsWith('emulator -avd'))).toBe(false)
  })

  test('an unknown AVD is a usage error', async () => {
    const r = await run(['device', 'boot', 'android', '--device', 'Nope', '--yes'])
    expect(r.code).toBe(2)
  })
})

describe('emulator args (android)', () => {
  const HEADLESS = '-no-window -no-audio -no-boot-anim'
  const boot = ['device', 'boot', 'android', '--device', 'Pixel_Test', '--yes']
  const emulatorLine = (): string | undefined => argv().find((l) => l.startsWith('emulator -avd'))
  const configure = (args: string[]): void =>
    writeFileSync(
      join(f.dir, 'kit.config.ts'),
      `export default { name: 'Devices', gradle: { root: '.' }, devices: { android: { emulatorArgs: ${JSON.stringify(args)} } } }\n`,
    )

  test('with none configured the emulator gets only the AVD', async () => {
    const r = await run(boot, { CI: '' })
    expect(r.code).toBe(0)
    expect(emulatorLine()).toBe('emulator -avd Pixel_Test')
    expect(r.stderr).not.toContain('emulator args')
  })

  test('in CI the headless flags follow the AVD', async () => {
    expect((await run(boot)).code).toBe(0)
    expect(emulatorLine()).toBe(`emulator -avd Pixel_Test ${HEADLESS}`)
  })

  test('config args are passed and printed', async () => {
    configure(['-feature', '-HardwareDecoder'])
    const r = await run(boot, { CI: '' })
    expect(r.code).toBe(0)
    expect(emulatorLine()).toBe('emulator -avd Pixel_Test -feature -HardwareDecoder')
    expect(r.stderr).toContain('  emulator args: -feature -HardwareDecoder')
  })

  test('KIT_EMULATOR_ARGS is split and passed', async () => {
    const r = await run(boot, { CI: '', KIT_EMULATOR_ARGS: '  -packet-streamer-endpoint   default ' })
    expect(r.code).toBe(0)
    expect(emulatorLine()).toBe('emulator -avd Pixel_Test -packet-streamer-endpoint default')
    expect(r.stderr).toContain('  emulator args: -packet-streamer-endpoint default')
  })

  test('order: the AVD, the CI headless flags, config args, then KIT_EMULATOR_ARGS', async () => {
    configure(['-feature', '-HardwareDecoder'])
    const r = await run(boot, { KIT_EMULATOR_ARGS: '-packet-streamer-endpoint default' })
    expect(r.code).toBe(0)
    expect(emulatorLine()).toBe(
      `emulator -avd Pixel_Test ${HEADLESS} -feature -HardwareDecoder -packet-streamer-endpoint default`,
    )
  })

  test('--dry-run prints the args and boots nothing', async () => {
    configure(['-feature', '-HardwareDecoder'])
    const r = await run([...boot, '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('  emulator args: -feature -HardwareDecoder')
    expect(emulatorLine()).toBeUndefined()
  })

  test('-avd in the config is a usage error: kit picks the AVD', async () => {
    configure(['-avd', 'Other'])
    const r = await run(boot)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('devices.android.emulatorArgs cannot hold -avd')
    expect(emulatorLine()).toBeUndefined()
  })

  test('@name in KIT_EMULATOR_ARGS is a usage error', async () => {
    const r = await run(boot, { KIT_EMULATOR_ARGS: '@Other -no-snapshot' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('KIT_EMULATOR_ARGS cannot hold @Other')
    expect(emulatorLine()).toBeUndefined()
  })

  test('an emulator already running is used as is, with one note that the args were not applied', async () => {
    configure(['-feature', '-HardwareDecoder'])
    writeFileSync(join(f.dir, '.up'), '')
    const note = 'emulator args not applied (the emulator was already running): -feature -HardwareDecoder -x'
    for (const args of [
      boot,
      ['device', 'boot', 'android'],
      ['device', 'statusbar', 'android', '--dry-run'],
    ]) {
      const r = await run(args, { KIT_EMULATOR_ARGS: '-x' })
      expect(r.code).toBe(0)
      expect(r.stderr.split(note).length).toBe(2)
    }
    expect(emulatorLine()).toBeUndefined()
  })

  test('an emulator already running prints no note when no args are configured', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    const r = await run(boot)
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('emulator args')
  })

  const logFile = join(tmpdir(), 'kit-emulator-Pixel_Test.log')
  const hint =
    'If the emulator needs other arguments to boot, set `devices.android.emulatorArgs` in kit.config.ts or `KIT_EMULATOR_ARGS`'

  test('a boot that never reaches adb times out with the emulator log tail, its path and the hint', async () => {
    fake(
      'emulator',
      `
case "$1" in
  -list-avds) echo Pixel_Test;;
  -avd) for n in 1 2 3 4 5 6 7; do echo "netsim line $n"; done; exec sleep 4;;
esac
exit 0`,
    )
    const r = await run(boot, { KIT_DEVICE_TIMEOUT_MS: '1500' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Gave up waiting for Pixel_Test to appear in adb devices')
    expect(r.stderr).toContain(
      ['netsim line 3', 'netsim line 4', 'netsim line 5', 'netsim line 6', 'netsim line 7'].join('\n'),
    )
    expect(r.stderr).not.toContain('netsim line 2')
    expect(r.stderr).toContain(`See ${logFile}`)
    expect(r.stderr).toContain(hint)
  })

  test('a boot that never completes times out the same way', async () => {
    fake(
      'emulator',
      `
case "$1" in
  -list-avds) echo Pixel_Test;;
  -avd) touch "$UP"; echo "stuck on boot animation"; exec sleep 4;;
esac
exit 0`,
    )
    fake('adb', adbFake.replace('*getprop*) echo 1;', '*getprop*) echo 0;'))
    const r = await run(boot, { KIT_DEVICE_TIMEOUT_MS: '1500' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Gave up waiting for Pixel_Test to finish booting')
    expect(r.stderr).toContain('stuck on boot animation')
    // The log is this boot's alone: nothing of an earlier, longer one is left under it.
    expect(r.stderr).not.toContain('netsim line')
    expect(r.stderr).toContain(`See ${logFile}`)
    expect(r.stderr).toContain(hint)
  })
})

describe('kit device statusbar (android)', () => {
  test('pins the status bar through demo mode', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    const r = await run(['device', 'statusbar', 'android'])
    expect(r.code).toBe(0)
    const lines = argv().filter((l) => l.startsWith('adb -s emulator-5554 shell'))
    expect(lines[0]).toBe('adb -s emulator-5554 shell cmd safety_center clear-data')
    expect(lines).toContain('adb -s emulator-5554 shell settings put global sysui_demo_allowed 1')
    expect(lines).toContain(
      'adb -s emulator-5554 shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941',
    )
  })

  test('--clear leaves demo mode', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    const r = await run(['device', 'statusbar', 'android', '--clear'])
    expect(r.code).toBe(0)
    expect(argv()).toContain(
      'adb -s emulator-5554 shell am broadcast -a com.android.systemui.demo -e command exit',
    )
    expect(argv().some((l) => l.includes('sysui_demo_allowed'))).toBe(false)
  })

  test('--dry-run prints the plan and runs nothing', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    const r = await run(['device', 'statusbar', 'android', '--dry-run', '--json'])
    const out = JSON.parse(r.stdout)
    expect(out.applied).toBe(false)
    expect(out.plan.length).toBe(8)
    expect(argv().some((l) => l.includes('am broadcast'))).toBe(false)
  })

  test('with no device running it fails with exit 4 and points at boot', async () => {
    const r = await run(['device', 'statusbar', 'android'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('kit device boot android')
    expect(argv().some((l) => l.startsWith('emulator -avd'))).toBe(false)
  })
})

const SIMS = (booted: boolean) =>
  JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
        {
          udid: 'UDID-PHONE',
          name: 'iPhone 17 Pro',
          state: booted ? 'Booted' : 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
        },
        {
          udid: 'UDID-PAD',
          name: 'iPad Pro 13-inch (M5)',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5',
        },
      ],
    },
  })

describe.if(process.platform === 'darwin')('kit device (ios)', () => {
  beforeEach(() => {
    writeFileSync(join(f.dir, '.sims-off.json'), SIMS(false))
    writeFileSync(join(f.dir, '.sims-on.json'), SIMS(true))
    fake(
      'xcrun',
      `
case "$*" in
  "simctl list devices -j") if [ -f "$UP" ]; then cat "${join(f.dir, '.sims-on.json')}"; else cat "${join(f.dir, '.sims-off.json')}"; fi;;
  "simctl boot "*) touch "$UP";;
esac
exit 0`,
    )
    fake('open', 'exit 0')
  })

  test('list ios --json shows the iPhone simulator, not the iPad', async () => {
    const r = await run(['device', 'list', 'ios', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).devices).toEqual([
      {
        id: 'UDID-PHONE',
        name: 'iPhone 17 Pro',
        platform: 'ios',
        kind: 'simulator',
        state: 'shutdown',
        os: '26.1',
        target: 'ios',
      },
    ])
  })

  test('boot ios --device boots that simulator', async () => {
    const r = await run(['device', 'boot', 'ios', '--device', 'iPhone 17 Pro', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ target: 'ios', id: 'UDID-PHONE', booted: true })
    expect(argv()).toContain('xcrun simctl boot UDID-PHONE')
    expect(argv()).toContain('xcrun simctl bootstatus UDID-PHONE -b')
  })

  test('statusbar ios pins and clears on the booted simulator', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    expect((await run(['device', 'statusbar', 'ios'])).code).toBe(0)
    expect(argv()).toContain(
      'xcrun simctl status_bar UDID-PHONE override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3',
    )
    expect((await run(['device', 'statusbar', 'ios', '--clear'])).code).toBe(0)
    expect(argv()).toContain('xcrun simctl status_bar UDID-PHONE clear')
  })

  test('statusbar ios with nothing booted fails with exit 4', async () => {
    const r = await run(['device', 'statusbar', 'ios'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('kit device boot ios')
  })

  test('statusbar ipad finds no iPad running', async () => {
    writeFileSync(join(f.dir, '.up'), '')
    expect((await run(['device', 'statusbar', 'ipad'])).code).toBe(4)
  })
})
