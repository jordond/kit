import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { KitConfig } from '../../config/schema'
import { log } from '../log'
import type { PlannedGroup } from '../targets'
import { findMaestro, maestroInstallHint } from './bin'

/** Name that selects the flow check on its own: `kit lint maestro`. */
export const MAESTRO_GROUP = 'maestro'

/** Every flow file under `maestro.dir` (repo-relative, sorted): `*.yaml` and `*.yml`, minus `config.yaml` and the output dir. */
export function flowFiles(root: string, config: KitConfig): string[] {
  const m = config.maestro
  if (!m) return []
  const output = relative(root, join(root, m.output ?? join(m.dir, 'output')))
  // A maestro.dir that does not exist yet has no flows; `kit qa` reports it, lint must not crash on it.
  if (!existsSync(join(root, m.dir))) return []
  const files: string[] = []
  for (const f of new Bun.Glob('**/*.{yaml,yml}').scanSync({ cwd: join(root, m.dir) })) {
    const path = join(m.dir, f)
    if (f.split('/').pop() === 'config.yaml' || path === output || path.startsWith(`${output}/`)) continue
    files.push(path)
  }
  return files.sort()
}

/**
 * The `maestro check-syntax` group of `kit lint`: one command per flow file (the CLI takes one file).
 * `staged` narrows it to staged flow files. Maestro is an optional tool here: not installed is one
 * warning and no group, never a failed lint.
 */
export function maestroLintGroup(
  root: string,
  config: KitConfig,
  opts: { staged?: string[] } = {},
): PlannedGroup | undefined {
  if (!config.maestro) return undefined
  let files = flowFiles(root, config)
  if (opts.staged) files = files.filter((f) => opts.staged?.includes(f))
  if (!files.length) return undefined
  const bin = findMaestro()
  if (bin === undefined) {
    log.warn(
      `maestro is not installed; skipping flow syntax checks (${maestroInstallHint(config.maestro.version)})`,
    )
    return undefined
  }
  return {
    title: MAESTRO_GROUP,
    commands: files.map((f) => ({ title: `check-syntax ${f}`, cmd: [bin, 'check-syntax', f], cwd: root })),
  }
}
