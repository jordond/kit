import type { Args, ArgValues, Command } from 'gunshi'
import type { KitConfig } from '../config/schema'
import { ExitCode, KitError } from '../lib/errors'
import { type Logger, log } from '../lib/log'

export type Group = 'Develop' | 'Quality' | 'Release' | 'Infra' | 'Setup' | (string & {})

/** Flags every command accepts. */
export const globalArgs = {
  json: { type: 'boolean', description: 'Write one JSON document to stdout; no prompts or animation' },
  'dry-run': { type: 'boolean', short: 'n', description: 'Plan and run read-only steps; skip mutations' },
  yes: { type: 'boolean', short: 'y', description: 'Accept confirmations (never skips prod)' },
  verbose: { type: 'boolean', short: 'v', description: 'Stream all child output' },
  quiet: { type: 'boolean', short: 'q', description: 'Errors and summary only' },
  bail: { type: 'boolean', description: 'Stop at the first failure' },
} as const satisfies Args

export interface Flags {
  json: boolean
  dryRun: boolean
  yes: boolean
  verbose: boolean
  quiet: boolean
  bail: boolean
  /** True when prompts are allowed: stdin and stderr are TTYs, not CI, not --json. */
  interactive: boolean
  ci: boolean
}

export interface KitContext<A extends Args = Args> {
  root: string | undefined
  config: KitConfig | undefined
  args: ArgValues<A>
  /** Positional arguments after the command path (`kit test api web` → ['api', 'web']). */
  positionals: string[]
  /** Arguments after `--`. */
  rest: string[]
  flags: Flags
  log: Logger
}

export interface KitCommand<A extends Args = Args> {
  description: string
  args?: A
  examples?: string
  group?: Group
  /** Env vars that must be set; checked before run (exit 3). */
  requiresEnv?: string[]
  /** Repo commands only: replace the built-in with the same path. */
  override?: boolean
  run(ctx: KitContext<A>): unknown | Promise<unknown>
}

/** Define a kit command. Heavy imports belong inside `run` so loading the file stays cheap. */
export function defineCommand<const A extends Args>(command: KitCommand<A>): KitCommand<A> {
  return command
}

export interface Runtime {
  root: string | undefined
  config: KitConfig | undefined
}

/** gunshi includes the subcommand tokens in positionals; drop them. */
function stripPath(positionals: string[], path: readonly string[] = []): string[] {
  let i = 0
  while (i < path.length && positionals[i] === path[i]) i++
  return positionals.slice(i)
}

/** Root and config, or exit 3 when kit runs outside a project. */
export function requireProject(ctx: Pick<KitContext, 'root' | 'config'>): {
  root: string
  config: KitConfig
} {
  if (!ctx.root || !ctx.config) {
    throw new KitError(
      'No kit.config.ts found here or in any parent directory',
      'Run `kit init`',
      ExitCode.config,
    )
  }
  return { root: ctx.root, config: ctx.config }
}

export function computeFlags(values: Record<string, unknown>): Flags {
  const ci = process.env.CI === 'true' || process.env.CI === '1'
  const json = values.json === true
  return {
    json,
    dryRun: values['dry-run'] === true,
    yes: values.yes === true,
    verbose: values.verbose === true,
    quiet: values.quiet === true,
    bail: values.bail === true,
    ci,
    interactive: !json && !ci && !process.env.KIT_NO_INPUT && !!process.stdin.isTTY && !!process.stderr.isTTY,
  }
}

/** Adapt a kit command to a gunshi command. */
export function toGunshi(name: string, cmd: KitCommand<Args>, rt: Runtime): Command & { group?: string } {
  return {
    name,
    description: cmd.description,
    examples: cmd.examples,
    args: { ...globalArgs, ...(cmd.args ?? {}) },
    group: cmd.group,
    run: async (ctx) => {
      const missing = (cmd.requiresEnv ?? []).filter((k) => !process.env[k])
      if (missing.length) {
        throw new KitError(
          `Missing env: ${missing.join(', ')}`,
          'Add them to .env or run `kit env init`',
          ExitCode.config,
        )
      }
      await cmd.run({
        root: rt.root,
        config: rt.config,
        args: ctx.values as ArgValues<Args>,
        positionals: stripPath(ctx.positionals, ctx.commandPath),
        rest: ctx.rest,
        flags: computeFlags(ctx.values),
        log,
      })
    },
  } as Command & { group?: string }
}
