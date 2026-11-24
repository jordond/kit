import type { Flags } from '../cli/command'
import type { KitConfig } from '../config/schema'
import { ExitCode, KitError } from './errors'
import { log } from './log'
import { runCapture, shell } from './proc'
import { commandStep, runSteps, summarize } from './steps'

export const CODEGEN_HINT = 'Run `kit codegen` and commit the result'

type Codegen = NonNullable<KitConfig['codegen']>

/** The `codegen` block, or exit 3 naming the field to add. */
export function requireCodegen(config: KitConfig): Codegen {
  if (!config.codegen) {
    throw new KitError(
      'No `codegen` in kit.config.ts',
      "Add `codegen: { run: '<command>', outputs: ['<generated file>'] }`; see docs/CONFIG.md",
      ExitCode.config,
    )
  }
  return config.codegen
}

/** Run `codegen.run` from the repo root as a step; returns false (and sets the exit code) on failure. */
export async function runCodegen(
  root: string,
  codegen: Codegen,
  flags: Flags,
  bail = false,
): Promise<boolean> {
  if (codegen.run === false) return true
  const cmds = Array.isArray(codegen.run) ? codegen.run : [codegen.run]
  const started = performance.now()
  const results = await runSteps(
    [{ title: 'codegen', steps: cmds.map((c) => commandStep(c, shell(c), { cwd: root })) }],
    flags,
    { bail },
  )
  const code = summarize('codegen', results, started)
  if (code) process.exitCode = code
  return code === 0
}

/**
 * Output paths that differ from HEAD or are untracked, as repo-relative paths. Outputs are git
 * pathspecs, so globs work; an output git ignores never shows up.
 */
export async function driftedOutputs(root: string, outputs: readonly string[]): Promise<string[]> {
  const { code, stdout } = await runCapture(
    ['git', 'status', '--porcelain', '-z', '-uall', '--', ...outputs],
    { cwd: root },
  )
  if (code !== 0) throw new KitError('git status failed', undefined, ExitCode.failed)
  // Entries are "XY path"; a rename adds a second, bare path entry, which is a changed file too.
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((e) => (/^.{2} /.test(e) ? e.slice(3) : e))
}

/** Throw when generated outputs are not what is committed. */
export async function assertNoDrift(root: string, outputs: readonly string[]): Promise<void> {
  const drift = await driftedOutputs(root, outputs)
  if (!drift.length) {
    log.success('codegen outputs are up to date')
    return
  }
  throw new KitError(
    `Codegen output is out of date: ${drift.length} ${drift.length === 1 ? 'file' : 'files'} differ from HEAD\n${drift.map((f) => `  ${f}`).join('\n')}`,
    CODEGEN_HINT,
    ExitCode.failed,
  )
}
