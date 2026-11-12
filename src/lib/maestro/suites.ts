import { join } from 'node:path'
import { DEFAULT_SUITES, type KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'

/**
 * Suites: named Maestro runs in kit.config.ts (`maestro.suites`). A suite is one or more stages,
 * each its own `maestro test` invocation. Stages exist because Maestro's `executionOrder` breaks
 * under `--include-tags`: a flow that wipes app state (onboarding) must run alone and last.
 */

export interface Suite {
  name: string
  /** Tag sets, one Maestro invocation each, in order. */
  stages: string[][]
  /** Fixture loaded before the first stage. */
  fixture?: string
  statusBar: boolean
  /** Repo-relative dir the screenshots are copied to (kit appends `<target>/`). */
  screenshots?: string
  env: Record<string, string>
}

type SuiteConfig = NonNullable<NonNullable<KitConfig['maestro']>['suites']>[string]

export function requireMaestro(config: KitConfig): NonNullable<KitConfig['maestro']> {
  if (!config.maestro) {
    throw new KitError(
      'kit.config.ts sets no maestro block',
      "Add maestro: { dir: '<dir with config.yaml and the flows>' }",
      ExitCode.config,
    )
  }
  return config.maestro
}

/** Repo-relative dir Maestro writes its run dirs under, per suite and target. */
export function outputDir(config: KitConfig, suite: string, target: string): string {
  const m = requireMaestro(config)
  return join(m.output ?? join(m.dir, 'output'), `${target}-${suite}`)
}

/** Suite names a command can run: the defaults plus the configured ones. */
export function suiteNames(config: KitConfig): string[] {
  return [...new Set([...Object.keys(DEFAULT_SUITES), ...Object.keys(config.maestro?.suites ?? {})])]
}

/** The suite `name`, with `extends` chains and the built-in default of the same name applied. */
export function resolveSuite(config: KitConfig, name: string): Suite {
  const m = requireMaestro(config)
  const configured = m.suites ?? {}
  // The default shots suite keeps its PNGs next to the flows; suites that extend it inherit the dir.
  const defaults: Record<string, SuiteConfig> = {
    ...DEFAULT_SUITES,
    shots: { ...DEFAULT_SUITES.shots, screenshots: join(m.dir, 'screenshots') },
  }
  if (!configured[name] && !defaults[name]) {
    throw new KitError(
      `No maestro suite "${name}"`,
      `Suites: ${suiteNames(config).join(', ')}; add it under maestro.suites in kit.config.ts`,
      ExitCode.config,
    )
  }
  const merged = flatten(name, configured, defaults, [])
  const stages = merged.stages ?? (merged.tags ? [merged.tags] : undefined)
  if (!stages) {
    throw new KitError(`maestro suite "${name}" names no tags or stages`, undefined, ExitCode.config)
  }
  return {
    name,
    stages: stages.map((s) => [...s]),
    fixture: merged.fixture === false ? undefined : merged.fixture,
    statusBar: merged.statusBar ?? false,
    screenshots: merged.screenshots,
    env: { ...merged.env },
  }
}

/** Parent first, then the suite's own fields; `stages` and `tags` replace each other. */
function flatten(
  name: string,
  configured: Record<string, SuiteConfig>,
  defaults: Record<string, SuiteConfig>,
  seen: string[],
): SuiteConfig {
  if (seen.includes(name)) {
    throw new KitError(
      `maestro suites extend each other in a loop: ${[...seen, name].join(' → ')}`,
      undefined,
      ExitCode.config,
    )
  }
  const own = configured[name]
  // A configured suite named like a default starts from that default.
  const base = defaults[name] ?? {}
  if (!own) return base
  const parent = own.extends ? flatten(own.extends, configured, defaults, [...seen, name]) : base
  const out: SuiteConfig = { ...parent, ...own, env: { ...parent.env, ...own.env } }
  if (own.stages) delete out.tags
  else if (own.tags) delete out.stages
  delete out.extends
  return out
}
