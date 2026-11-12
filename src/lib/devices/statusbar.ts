import { KitError } from '../errors'
import { runPiped } from '../proc'

/**
 * Pin a simulator's or emulator's status bar to 9:41 with full signal and battery (the time
 * Apple's own marketing shots use, so a store screenshot set wants it too), or restore it.
 * The builders are pure so `--dry-run` can print exactly what would run.
 */

const IOS_OVERRIDE = [
  '--time',
  '9:41',
  '--batteryState',
  'charged',
  '--batteryLevel',
  '100',
  '--cellularBars',
  '4',
  '--wifiBars',
  '3',
]

export function iosStatusBarCommands(udid: string, clear: boolean): string[][] {
  const base = ['xcrun', 'simctl', 'status_bar', udid]
  return [clear ? [...base, 'clear'] : [...base, 'override', ...IOS_OVERRIDE]]
}

const DEMO = ['am', 'broadcast', '-a', 'com.android.systemui.demo']

const ANDROID_DEMO_COMMANDS: string[][] = [
  ['-e', 'command', 'enter'],
  ['-e', 'command', 'clock', '-e', 'hhmm', '0941'],
  ['-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false'],
  // A shown mobile icon carries the emulator's grey "3G" data type into every shot, and a wifi
  // icon that is not `fully` connected carries an exclamation mark.
  ['-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4', '-e', 'fully', 'true'],
  ['-e', 'command', 'network', '-e', 'mobile', 'hide'],
  ['-e', 'command', 'notifications', '-e', 'visible', 'false'],
]

export function androidStatusBarCommands(adbBin: string, serial: string, clear: boolean): string[][] {
  const shell = [adbBin, '-s', serial, 'shell']
  if (clear) return [[...shell, ...DEMO, '-e', 'command', 'exit']]
  return [
    // Demo mode's `notifications visible false` no longer hides notification icons, and a fresh
    // AVD carries Safety Center's "Set a screen lock" shield until its data is cleared.
    [...shell, 'cmd', 'safety_center', 'clear-data'],
    [...shell, 'settings', 'put', 'global', 'sysui_demo_allowed', '1'],
    ...ANDROID_DEMO_COMMANDS.map((command) => [...shell, ...DEMO, ...command]),
  ]
}

/** Run the commands in order; the first failure stops with its output. */
export async function runStatusBarCommands(commands: readonly string[][]): Promise<void> {
  for (const cmd of commands) {
    const { code, stdout, stderr } = await runPiped(cmd)
    // Safety Center is absent below Android 14, so clearing it may fail.
    if (code !== 0 && !cmd.includes('safety_center')) {
      throw new KitError(`${cmd.join(' ')} failed (exit ${code})`, (stderr || stdout).trim() || undefined)
    }
  }
}
