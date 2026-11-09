import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Flags } from '../../cli/command'
import type { KitConfig, Track } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import type { Logger } from '../log'

/**
 * `release.preflight` modules (PLAN §10.2): repo checks run before every mobile release, e.g. brewd's
 * punchcard seed and what's-new checks. A check throws (ideally a KitError with a hint) to stop the
 * release. `skipFlag` names the `--skip <name>` value that bypasses it.
 */

export interface PreflightInfo {
  platform: 'ios' | 'android'
  track: Track
  /** The version name being released. */
  version: string
}

export interface PreflightContext {
  root: string
  config: KitConfig
  flags: Flags
  log: Logger
}

export interface Preflight {
  title: string
  /** `kit release ios --skip <skipFlag>` bypasses this check. */
  skipFlag?: string
  /** Platforms this applies to; default both. */
  platforms?: ('ios' | 'android')[]
  check(ctx: PreflightContext, info: PreflightInfo): void | Promise<void>
}

export function definePreflight(p: Preflight): Preflight {
  return p
}

export async function loadPreflights(root: string, config: KitConfig): Promise<Preflight[]> {
  const out: Preflight[] = []
  for (const path of config.release?.preflight ?? []) {
    let mod: { default?: Preflight }
    try {
      mod = await import(pathToFileURL(join(root, path)).href)
    } catch (e) {
      throw new KitError(
        `Cannot load preflight ${path}: ${e instanceof Error ? e.message : String(e)}`,
        'Check release.preflight in kit.config.ts',
        ExitCode.config,
      )
    }
    const p = mod.default
    if (!p || typeof p.check !== 'function' || !p.title) {
      throw new KitError(
        `${path} does not default-export definePreflight({ title, check })`,
        undefined,
        ExitCode.config,
      )
    }
    out.push(p)
  }
  return out
}
