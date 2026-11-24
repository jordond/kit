import { dirname } from 'node:path'
import { ExitCode, KitError } from '../lib/errors'
import { copyVerdict } from '../lib/kit-copy'
import { KIT_PACKAGE } from '../lib/kitref'

/** Commands that must work with any kit: they inspect or repair the install, or never touch the repo. */
const ANY_COPY = ['doctor', 'upgrade', 'init', 'completion', 'complete']

interface Out {
  warn(message: string): void
  dim(message: string): void
}

export interface EnsureCopyDeps {
  /** The command words of the invocation (flags stripped). */
  tokens: string[]
  /** The kit running now; absent when it cannot be located. */
  own: { dir: string; version: string } | undefined
  /** Leave everything alone: a source checkout, or the child of a handoff. */
  skip: boolean
  log: Out
  spawn?: (cli: string, argv: string[], root: string) => Promise<number>
}

const whereOf = (manifest: string): string =>
  dirname(manifest) === '.' ? 'the repo root' : dirname(manifest)

/**
 * The launcher hands off to the repo's own kit, but only for the layouts its release knows: an
 * older global kit can end up running itself in a repo pinned to a newer one. Before anything of
 * the repo loads, run the repo's copy instead when there is one, and refuse to run a copy the
 * repo's pin excludes. Returns the exit code of the handed-off run, or undefined to carry on here.
 */
export async function ensureCopy(
  root: string,
  argv: string[],
  { tokens, own, skip, log, spawn = spawnCopy }: EnsureCopyDeps,
): Promise<number | undefined> {
  if (skip || !own) return undefined
  const verdict = copyVerdict(root, own)
  const quiet = tokens[0] === 'complete' || tokens[0] === 'completion'
  const dashdash = argv.indexOf('--')
  const json = (dashdash < 0 ? argv : argv.slice(0, dashdash)).includes('--json')
  if (verdict.kind !== 'mismatch' && verdict.stale && !quiet && !json) {
    // Typically a pulled kit bump without a reinstall: the old copy runs and rejects newer config.
    const { range, manifest, version } = verdict.stale
    log.warn(`The installed kit is ${version} but ${manifest} pins "${range}"`)
    log.dim(`  › Run the package manager's install in ${whereOf(manifest)}`)
  }
  if (verdict.kind === 'ok') return undefined
  if (verdict.kind === 'handoff') return spawn(verdict.cli, argv, root)
  const message = `This repo pins ${KIT_PACKAGE} "${verdict.range}" (${verdict.manifest}) but it is not installed, and this kit is ${own.version}`
  const hint = `Install the repo's kit: run the package manager's install in ${whereOf(verdict.manifest)}`
  if (
    tokens.length === 0 ||
    ANY_COPY.includes(tokens[0]!) ||
    argv.includes('--version') ||
    argv.includes('-V')
  ) {
    if (!quiet) {
      log.warn(message)
      log.dim(`  › ${hint}`)
    }
    return undefined
  }
  throw new KitError(message, hint, ExitCode.precondition)
}

function spawnCopy(cli: string, argv: string[], root: string): Promise<number> {
  return Bun.spawn([process.execPath, '--no-env-file', cli, ...argv], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, KIT_ROOT: root, KIT_HANDOFF: '1' },
  }).exited
}
