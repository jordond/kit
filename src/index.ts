import type { KitConfigInput } from './config/schema'

export type { Group, KitCommand, KitContext } from './cli/command'
export { defineCommand } from './cli/command'
export type { KitConfig, KitConfigInput } from './config/schema'
export { ExitCode, KitError } from './lib/errors'

/** Typed identity helper for `kit.config.ts`. Validation happens when kit loads the file. */
export function defineConfig(config: KitConfigInput): KitConfigInput {
  return config
}
