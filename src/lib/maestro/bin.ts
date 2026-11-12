import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Flags } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'

/** The install one-liner; `MAESTRO_VERSION` pins what it installs. */
export function maestroInstallHint(version?: string): string {
  return `${version ? `MAESTRO_VERSION=${version} ` : ''}curl -Ls https://get.maestro.mobile.dev | bash`
}

/** The resolved binary, or undefined when Maestro is not installed. */
export function findMaestro(): string | undefined {
  const onPath = Bun.which('maestro')
  if (onPath !== null) return onPath
  // The installer only extends the PATH of an interactive bash or zsh profile; CI, hooks and fish miss it.
  const installed = join(homedir(), '.maestro', 'bin', 'maestro')
  return existsSync(installed) ? installed : undefined
}

/** `maestro` from PATH, then `~/.maestro/bin`; a precondition failure with the install hint otherwise. */
export function maestroBin(config?: Pick<KitConfig, 'maestro'>): string {
  const bin = findMaestro()
  if (bin !== undefined) return bin
  throw new KitError(
    'maestro not found on PATH or in ~/.maestro/bin',
    maestroInstallHint(config?.maestro?.version),
    ExitCode.precondition,
  )
}

/** Env for every Maestro child: no analytics or update check, and a longer driver start in CI. */
export function maestroEnv(flags: Pick<Flags, 'ci'>): Record<string, string> {
  return {
    MAESTRO_CLI_NO_ANALYTICS: '1',
    MAESTRO_DISABLE_UPDATE_CHECK: 'true',
    ...(flags.ci && process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT === undefined
      ? { MAESTRO_DRIVER_STARTUP_TIMEOUT: '240000' }
      : {}),
  }
}
