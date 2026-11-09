import type { KitConfigInput } from './config/schema'

export type { BuiltinOptions, Flags, Group, KitCommand, KitContext } from './cli/command'
export { defineCommand } from './cli/command'
export type { KitConfig, KitConfigInput } from './config/schema'
export { onCleanup } from './lib/cleanup'
export { ExitCode, KitError } from './lib/errors'
export {
  addChildEnv,
  ProcError,
  run,
  runCapture,
  runInteractive,
  runLines,
  runOrThrow,
  runQuiet,
} from './lib/proc'
export {
  definePreflight,
  type Preflight,
  type PreflightContext,
  type PreflightInfo,
} from './lib/release/preflight'
export { commandStep, runSteps, type Step, type StepGroup, type StepResult } from './lib/steps'

/** Typed identity helper for `kit.config.ts`. Validation happens when kit loads the file. */
export function defineConfig(config: KitConfigInput): KitConfigInput {
  return config
}
