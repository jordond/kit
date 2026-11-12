import { describe, expect, test } from 'bun:test'
import { configSchema } from '../../src/config/schema'
import { emulatorArgs, splitArgs } from '../../src/lib/devices/emulator-args'
import { ExitCode, KitError } from '../../src/lib/errors'

const usageError = (fn: () => unknown): KitError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(KitError)
    expect((e as KitError).exitCode).toBe(ExitCode.usage)
    return e as KitError
  }
  throw new Error('did not throw')
}

describe('splitArgs', () => {
  test('splits on whitespace', () => {
    expect(splitArgs('-feature -HardwareDecoder')).toEqual(['-feature', '-HardwareDecoder'])
  })

  test('ignores whitespace at the ends and runs of it between', () => {
    expect(splitArgs('  -gpu \t host\n -no-snapshot  ')).toEqual(['-gpu', 'host', '-no-snapshot'])
  })

  test('empty and blank are no arguments', () => {
    expect(splitArgs('')).toEqual([])
    expect(splitArgs('   ')).toEqual([])
  })

  test('quotes keep whitespace, and the other quote, in one argument', () => {
    expect(splitArgs(`-prop "a b" -qemu '-append "x y"'`)).toEqual(['-prop', 'a b', '-qemu', '-append "x y"'])
  })

  test('a quoted part joins the text around it', () => {
    expect(splitArgs(`-prop key="a b"c`)).toEqual(['-prop', 'key=a bc'])
  })

  test('an empty pair of quotes is an empty argument', () => {
    expect(splitArgs(`-dns-server ''`)).toEqual(['-dns-server', ''])
  })

  test('an unclosed quote is a usage error', () => {
    expect(usageError(() => splitArgs(`-prop "a b`)).message).toContain('Unclosed "')
  })
})

describe('emulatorArgs', () => {
  const config = { devices: { android: { emulatorArgs: ['-feature', '-HardwareDecoder'] } } }

  test('none configured is no arguments', () => {
    expect(emulatorArgs({}, {})).toEqual([])
    expect(emulatorArgs({ devices: {} }, { KIT_EMULATOR_ARGS: '' })).toEqual([])
  })

  test('config args come first, then KIT_EMULATOR_ARGS', () => {
    expect(emulatorArgs(config, { KIT_EMULATOR_ARGS: '-packet-streamer-endpoint default' })).toEqual([
      '-feature',
      '-HardwareDecoder',
      '-packet-streamer-endpoint',
      'default',
    ])
  })

  test('nothing but the AVD choice is filtered', () => {
    const args = ['-no-window', '-wipe-data', '-avd-arch', 'a@b']
    expect(emulatorArgs({ devices: { android: { emulatorArgs: args } } }, {})).toEqual(args)
  })

  test('-avd and @name are refused from either source', () => {
    for (const bad of ['-avd', '@Pixel_9']) {
      const fromConfig = usageError(() => emulatorArgs({ devices: { android: { emulatorArgs: [bad] } } }, {}))
      expect(fromConfig.message).toBe(`devices.android.emulatorArgs cannot hold ${bad}: kit picks the AVD`)
      const fromEnv = usageError(() => emulatorArgs({}, { KIT_EMULATOR_ARGS: `-no-snapshot ${bad}` }))
      expect(fromEnv.message).toBe(`KIT_EMULATOR_ARGS cannot hold ${bad}: kit picks the AVD`)
    }
  })
})

describe('devices.android.emulatorArgs in the schema', () => {
  const parse = (emulatorArgs: unknown) =>
    configSchema.safeParse({ name: 'App', devices: { android: { emulatorArgs } } })

  test('accepts a list of arguments, and its absence', () => {
    const parsed = parse(['-feature', '-HardwareDecoder'])
    expect(parsed.success).toBe(true)
    expect(parsed.data?.devices?.android?.emulatorArgs).toEqual(['-feature', '-HardwareDecoder'])
    expect(configSchema.safeParse({ name: 'App', devices: { android: {} } }).success).toBe(true)
    expect(configSchema.safeParse({ name: 'App' }).success).toBe(true)
  })

  test('rejects an empty argument, a non-array and an unknown key', () => {
    expect(parse(['-feature', '']).success).toBe(false)
    expect(parse('-feature -HardwareDecoder').success).toBe(false)
    expect(parse([1]).success).toBe(false)
    expect(configSchema.safeParse({ name: 'App', devices: { android: { args: [] } } }).success).toBe(false)
  })
})
