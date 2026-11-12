import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'

/**
 * The extra arguments kit passes to `emulator -avd <avd>`: what the project needs
 * (`devices.android.emulatorArgs` in kit.config.ts), then what this machine needs
 * (`KIT_EMULATOR_ARGS`). Pure, so the order and the refusals are tested without an emulator.
 */

/** Where the two sources are named in messages. */
export const EMULATOR_ARGS_SOURCES = '`devices.android.emulatorArgs` in kit.config.ts or `KIT_EMULATOR_ARGS`'

/**
 * Split a string into arguments the way a shell would, minus everything but quotes: whitespace
 * separates, `'…'` and `"…"` keep whitespace (and the other quote) inside one argument, `''` is an
 * empty argument. No escapes, no expansion.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = []
  let current: string | undefined
  let quote: string | undefined
  for (const ch of input) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current = (current ?? '') + ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      current ??= ''
    } else if (/\s/.test(ch)) {
      if (current !== undefined) args.push(current)
      current = undefined
    } else {
      current = (current ?? '') + ch
    }
  }
  if (quote !== undefined) {
    throw new KitError(`Unclosed ${quote} in "${input}"`, undefined, ExitCode.usage)
  }
  if (current !== undefined) args.push(current)
  return args
}

/** Config args, then `KIT_EMULATOR_ARGS`. kit owns which AVD boots, so `-avd` and `@name` are refused. */
export function emulatorArgs(
  config: Pick<KitConfig, 'devices'>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const fromConfig = config.devices?.android?.emulatorArgs ?? []
  const fromEnv = splitArgs(env.KIT_EMULATOR_ARGS ?? '')
  const check = (args: readonly string[], source: string): void => {
    const bad = args.find((arg) => arg === '-avd' || arg.startsWith('@'))
    if (bad !== undefined) {
      throw new KitError(
        `${source} cannot hold ${bad}: kit picks the AVD`,
        'Name the AVD with --device or `maestro.devices.android`',
        ExitCode.usage,
      )
    }
  }
  check(fromConfig, 'devices.android.emulatorArgs')
  check(fromEnv, 'KIT_EMULATOR_ARGS')
  return [...fromConfig, ...fromEnv]
}
