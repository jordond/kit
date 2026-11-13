import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type KitContext, requireProject } from '../../cli/command'
import { ExitCode, KitError } from '../errors'
import { emitJson } from '../log'
import { migrateChecked } from './migrate'
import { repoPath } from './plan'
import { loadProject } from './project'
import type { ProjectV2 } from './types'

/** The `--json` document of `kit shots migrate`. */
export interface MigrateResult {
  dryRun: boolean
  /** `shots.project`, relative to the repo root. */
  file: string
  /** Whether the file was replaced: only under `--write`, and never in a dry run. */
  written: boolean
  project: ProjectV2
}

/**
 * `kit shots migrate`: the saved version 1 project as version 2. Proves the round trip first (the
 * migrated project draws the same slides on every target and locale) and writes nothing when it
 * does not. Without `--write` the version 2 JSON goes to stdout; with it, `shots.project` is
 * replaced, unless `--dry-run`.
 */
export async function migrateShots(ctx: KitContext, opts: { write: boolean }): Promise<void> {
  const { root, config } = requireProject(ctx)
  if (!config.shots) {
    throw new KitError(
      'No shots block in kit.config.ts',
      "Add shots: { project: '<saved project>.json' } to kit.config.ts",
      ExitCode.config,
    )
  }
  const file = resolve(root, config.shots.project)
  const name = repoPath(root, file)
  const project = await loadProject(file)
  if (project.version === 2) {
    throw new KitError(`${name} is already a version 2 project`, 'Nothing to migrate', ExitCode.precondition)
  }
  const migrated = migrateChecked(project)
  const written = opts.write && !ctx.flags.dryRun
  if (written) writeFileSync(file, `${JSON.stringify(migrated, null, 2)}\n`)

  if (ctx.flags.json) {
    emitJson({ dryRun: ctx.flags.dryRun, file: name, written, project: migrated } satisfies MigrateResult)
    return
  }
  const count = `${migrated.slides.length} slide${migrated.slides.length === 1 ? '' : 's'}`
  if (!opts.write) {
    process.stdout.write(`${JSON.stringify(migrated, null, 2)}\n`)
    ctx.log.info(`${name}: ${count}; the version 2 project is above. Run with --write to replace the file`)
  } else if (written) {
    ctx.log.success(`${name} is now a version 2 project (${count}); the round trip is proven`)
  } else {
    ctx.log.info(`Dry run: ${name} would become a version 2 project (${count}); the round trip is proven`)
  }
}
