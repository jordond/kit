import { describe, expect, test } from 'bun:test'
import { parseTarget, setIniKeys } from '../../src/lib/devices'
import {
  latestLargestIpad,
  latestLargestIphone,
  latestLargestPixel,
  latestVersion,
  preferredAmong,
  preferredSystemImage,
  systemImagePackage,
} from '../../src/lib/devices/pick'
import { androidStatusBarCommands, iosStatusBarCommands } from '../../src/lib/devices/statusbar'
import { KitError } from '../../src/lib/errors'

const names = (...list: string[]): { name: string }[] => list.map((name) => ({ name }))

describe('latestLargestPixel', () => {
  test('takes the newest generation, and the XL within it', () => {
    const ids = ['pixel_9_pro_xl', 'pixel_10', 'pixel_10_pro', 'pixel_10_pro_xl', 'pixel_10a', 'pixel_9a']
    expect(latestLargestPixel(ids)).toBe('pixel_10_pro_xl')
  })

  test('skips folds, tablets and non-Pixel definitions', () => {
    expect(
      latestLargestPixel(['pixel_10_pro_fold', 'pixel_tablet', 'pixel_c', 'Nexus 5', 'pixel_9_pro']),
    ).toBe('pixel_9_pro')
  })

  test('reads the old _xl suffix as the large one', () => {
    expect(latestLargestPixel(['pixel_3', 'pixel_3_xl', 'pixel_3a_xl'])).toBe('pixel_3_xl')
  })

  test('is undefined with nothing to pick', () => {
    expect(latestLargestPixel(['pixel_fold'])).toBeUndefined()
  })
})

describe('latestLargestIphone', () => {
  test('takes the newest Pro Max over everything else', () => {
    expect(
      latestLargestIphone(
        names('iPhone 17 Pro Max', 'iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone 18', 'iPhone Air'),
      ),
    ).toEqual({ name: 'iPhone 18 Pro Max' })
  })

  test('falls back to Plus, then Pro, then the plain one', () => {
    expect(latestLargestIphone(names('iPhone 16', 'iPhone 16 Plus', 'iPhone 16 Pro'))).toEqual({
      name: 'iPhone 16 Plus',
    })
    expect(latestLargestIphone(names('iPhone 16', 'iPhone 16 Pro'))).toEqual({ name: 'iPhone 16 Pro' })
    expect(latestLargestIphone(names('iPhone 16', 'iPhone 16e'))).toEqual({ name: 'iPhone 16' })
  })

  test('never picks an SE, a mini, or an iPad', () => {
    expect(
      latestLargestIphone(names('iPhone SE (3rd generation)', 'iPhone 13 mini', 'iPad Pro 13-inch (M4)')),
    ).toBeUndefined()
  })
})

describe('latestLargestIpad', () => {
  test('takes the 13-inch on the newest chip, Pro over Air', () => {
    expect(
      latestLargestIpad(
        names(
          'iPad Pro 11-inch (M5)',
          'iPad Air 13-inch (M4)',
          'iPad Pro 13-inch (M4)',
          'iPad Pro 13-inch (M5)',
        ),
      ),
    ).toEqual({ name: 'iPad Pro 13-inch (M5)' })
    expect(latestLargestIpad(names('iPad Air 13-inch (M4)', 'iPad Pro 13-inch (M4)'))).toEqual({
      name: 'iPad Pro 13-inch (M4)',
    })
  })

  test('ranks any M chip over an A chip and a generation, and inches over both', () => {
    expect(latestLargestIpad(names('iPad mini (A17 Pro)', 'iPad (A16)', 'iPad Pro 11-inch (M5)'))).toEqual({
      name: 'iPad Pro 11-inch (M5)',
    })
    expect(
      latestLargestIpad(names('iPad Pro (12.9-inch) (6th generation)', 'iPad Pro 11-inch (M5)')),
    ).toEqual({ name: 'iPad Pro (12.9-inch) (6th generation)' })
  })

  test('never picks an iPhone', () => {
    expect(latestLargestIpad(names('iPhone 17 Pro Max', 'iPhone Air'))).toBeUndefined()
  })
})

describe('latestVersion', () => {
  test('compares dotted versions numerically', () => {
    const items = [{ version: '9.0' }, { version: '27.0' }, { version: '26.5' }, { version: '27' }]
    expect(latestVersion(items)).toEqual({ version: '27.0' })
  })
})

describe('latestVersion with non-numeric parts', () => {
  test('an extension API dir never beats a higher plain one', () => {
    const at = (api: string) => ({ api, tag: 'google_apis', abi: 'arm64-v8a' })
    expect(preferredSystemImage([at('33-ext5'), at('36')], 'arm64-v8a')?.api).toBe('36')
    expect(preferredSystemImage([at('36'), at('33-ext5')], 'arm64-v8a')?.api).toBe('36')
  })
})

describe('preferredSystemImage', () => {
  const images = [
    { api: '36', tag: 'google_apis', abi: 'arm64-v8a' },
    { api: '36', tag: 'google_apis_playstore', abi: 'arm64-v8a' },
    { api: '37.1', tag: 'google_apis_playstore_ps16k', abi: 'arm64-v8a' },
    { api: '37.1', tag: 'google_apis', abi: 'x86_64' },
  ]

  test('a Play image always wins: the newest API among them', () => {
    expect(preferredSystemImage(images, 'arm64-v8a')).toEqual({
      api: '37.1',
      tag: 'google_apis_playstore_ps16k',
      abi: 'arm64-v8a',
    })
    const older = [
      { api: '34', tag: 'google_apis_playstore', abi: 'arm64-v8a' },
      { api: '36', tag: 'google_apis', abi: 'arm64-v8a' },
    ]
    expect(preferredSystemImage(older, 'arm64-v8a')?.api).toBe('34')
  })

  test('at one API: plain Play over a Play variant; without Play, google_apis over default', () => {
    const at = (...tags: string[]) => tags.map((tag) => ({ api: '36', tag, abi: 'arm64-v8a' }))
    expect(
      preferredSystemImage(
        at('google_apis_playstore_ps16k', 'google_apis', 'google_apis_playstore'),
        'arm64-v8a',
      )?.tag,
    ).toBe('google_apis_playstore')
    expect(preferredSystemImage(at('default', 'google_apis'), 'arm64-v8a')?.tag).toBe('google_apis')
  })

  test('excludes TV, Wear and Automotive tags', () => {
    const at = (...tags: string[]) => tags.map((tag) => ({ api: '36', tag, abi: 'arm64-v8a' }))
    expect(preferredSystemImage(at('android-tv', 'android-wear', 'android-automotive'), 'arm64-v8a')).toBe(
      undefined,
    )
    expect(preferredSystemImage(at('android-tv', 'default'), 'arm64-v8a')?.tag).toBe('default')
  })

  test('ignores images built for another abi', () => {
    expect(preferredSystemImage(images, 'x86')).toBeUndefined()
  })

  test('names the package avdmanager installs from', () => {
    expect(systemImagePackage({ api: '37.1', tag: 'google_apis', abi: 'arm64-v8a' })).toBe(
      'system-images;android-37.1;google_apis;arm64-v8a',
    )
  })
})

describe('preferredAmong', () => {
  test('takes an emulator over a phone on Android', () => {
    const devices = [
      { id: 'R5CX', label: 'R5CX (SM F966B)' },
      { id: 'emulator-5554', label: 'emulator-5554 (sdk gphone64)' },
    ]
    expect(preferredAmong('android', devices).id).toBe('emulator-5554')
  })

  test('takes the newest, largest iPhone among booted simulators', () => {
    const devices = [
      { id: 'A', label: 'iPhone 18 Pro (A)' },
      { id: 'B', label: 'iPhone 17 Pro Max (B)' },
    ]
    expect(preferredAmong('ios', devices).id).toBe('A')
  })

  test('takes the largest iPad when asked for one', () => {
    const devices = [
      { id: 'A', label: 'iPad Air 13-inch (M4) (A)' },
      { id: 'B', label: 'iPad Pro 13-inch (M5) (B)' },
    ]
    expect(preferredAmong('ios', devices, 'ipad').id).toBe('B')
  })

  test('falls back to the first listed', () => {
    const devices = [
      { id: 'X', label: 'X (Pixel 8)' },
      { id: 'Y', label: 'Y (Pixel 9)' },
    ]
    expect(preferredAmong('android', devices).id).toBe('X')
  })
})

describe('setIniKeys', () => {
  test('replaces an existing key in place', () => {
    expect(setIniKeys('a=1\nhw.keyboard=no\nb=2\n', { 'hw.keyboard': 'yes' })).toBe(
      'a=1\nhw.keyboard=yes\nb=2\n',
    )
  })

  test('appends a missing key', () => {
    expect(setIniKeys('a=1\n', { 'disk.dataPartition.size': '8G' })).toBe('a=1\ndisk.dataPartition.size=8G\n')
  })

  test('does not treat the dot as a wildcard', () => {
    expect(setIniKeys('hwxkeyboard=no\n', { 'hw.keyboard': 'yes' })).toBe('hwxkeyboard=no\nhw.keyboard=yes\n')
  })
})

describe('parseTarget', () => {
  test('accepts the three targets', () => {
    expect(parseTarget('ios', 'device boot')).toBe('ios')
    expect(parseTarget('ipad', 'device boot')).toBe('ipad')
    expect(parseTarget('android', 'device boot')).toBe('android')
  })

  test('rejects a missing, unknown or disallowed target with exit 2', () => {
    for (const value of [undefined, 'watch']) {
      try {
        parseTarget(value, 'device boot')
        throw new Error('did not throw')
      } catch (error) {
        expect(error).toBeInstanceOf(KitError)
        expect((error as KitError).exitCode).toBe(2)
      }
    }
    expect(() => parseTarget('ipad', 'app build', ['ios', 'android'])).toThrow('Unknown platform')
  })
})

describe('status bar commands', () => {
  test('ios override and clear', () => {
    expect(iosStatusBarCommands('U1', false)).toEqual([
      [
        ...['xcrun', 'simctl', 'status_bar', 'U1', 'override'],
        ...['--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100'],
        ...['--cellularBars', '4', '--wifiBars', '3'],
      ],
    ])
    expect(iosStatusBarCommands('U1', true)).toEqual([['xcrun', 'simctl', 'status_bar', 'U1', 'clear']])
  })

  test('android pins through demo mode, clearing Safety Center first', () => {
    const cmds = androidStatusBarCommands('adb', 'emulator-5554', false)
    const shell = ['adb', '-s', 'emulator-5554', 'shell']
    expect(cmds[0]).toEqual([...shell, 'cmd', 'safety_center', 'clear-data'])
    expect(cmds[1]).toEqual([...shell, 'settings', 'put', 'global', 'sysui_demo_allowed', '1'])
    const broadcasts = cmds.slice(2)
    for (const c of broadcasts) {
      expect(c.slice(0, 8)).toEqual([...shell, 'am', 'broadcast', '-a', 'com.android.systemui.demo'])
    }
    const joined = broadcasts.map((c) => c.slice(8).join(' '))
    expect(joined).toEqual([
      '-e command enter',
      '-e command clock -e hhmm 0941',
      '-e command battery -e level 100 -e plugged false',
      '-e command network -e wifi show -e level 4 -e fully true',
      '-e command network -e mobile hide',
      '-e command notifications -e visible false',
    ])
  })

  test('android clear exits demo mode', () => {
    expect(androidStatusBarCommands('/sdk/adb', 'R5CX', true)).toEqual([
      [
        '/sdk/adb',
        '-s',
        'R5CX',
        'shell',
        'am',
        'broadcast',
        '-a',
        'com.android.systemui.demo',
        '-e',
        'command',
        'exit',
      ],
    ])
  })
})
