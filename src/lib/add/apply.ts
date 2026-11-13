import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pc from 'picocolors'
import type { KitContext } from '../../cli/command'
import { ExitCode, KitError } from '../errors'
import { emitJson } from '../log'
import { runCapture } from '../proc'
import type { FileAction } from '../scaffold'
import type { AddPlan } from './plan'

/** kit's `templates/add/` files by relative path, unrendered. */
export function addTemplates(kitRoot: string): Record<string, string> {
  const dir = join(kitRoot, 'templates', 'add')
  const files: Record<string, string> = {}
  for (const rel of new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true, dot: true })) {
    files[rel] = readFileSync(join(dir, rel), 'utf8')
  }
  return files
}

export interface Added {
  add: 'module' | 'target' | 'maestro'
  name: string
  /** Repo-relative directory of the module or target. */
  dir: string
  /** Commands to run next, shown after a successful add. */
  next: string[]
  /** The repo's config file when the plan edits it: written first and proven before anything else. */
  configFile?: string
  /** What `kit config` must report for the new target. */
  target?: { kind: string; dir: string }
}

const describe = (a: FileAction) =>
  a.kind === 'write' ? `write ${a.path}` : a.kind === 'edit' ? `edit ${a.path}  ${pc.dim(a.note)}` : ''

/**
 * A fresh kit process loads the config (this one has the old module cached). Undefined when it
 * loads and, for a new target, lists it as planned; else why not.
 */
async function configProblem(root: string, added: Added): Promise<string | undefined> {
  const self = [process.execPath, '--no-env-file', process.argv[1]!, 'config']
  const r = await runCapture(self, { cwd: root, env: { KIT_ROOT: root } })
  if (r.code !== 0) return 'it no longer loads'
  if (!added.target) return undefined
  try {
    const got = JSON.parse(r.stdout).config?.targets?.[added.name]
    if (got?.kind === added.target.kind && got?.dir === added.target.dir) return undefined
  } catch {}
  return `it does not list target ${added.name} as written`
}

/**
 * Show the plan, then write it: the shared second half of `kit add module` and `kit add target`.
 * Existing files are refused (exit 2) before anything is written; `--dry-run` stops after the
 * plan; `--json` puts the plan or the result on stdout as one document.
 */
export async function applyAdd(
  ctx: Pick<KitContext, 'flags' | 'log'>,
  root: string,
  plan: AddPlan,
  added: Added,
): Promise<void> {
  const { flags, log } = ctx
  const say = !flags.json
  const { configFile, target: _target, ...summary } = added
  if (plan.manual) {
    const { file, where, snippet } = plan.manual
    const message = `${file} is not a shape kit edits; nothing was written`
    const hint = `Add the line ${say ? 'above' : 'in `snippet`'} to ${where} in ${file}, then re-run`
    if (flags.json) emitJson({ ok: false, error: message, hint, file, snippet, exitCode: ExitCode.failed })
    else process.stdout.write(`${snippet}\n`)
    throw new KitError(message, hint, ExitCode.failed)
  }
  if (plan.conflicts.length) {
    throw new KitError(
      `These files already exist:\n${plan.conflicts.map((p) => `  ${p}`).join('\n')}`,
      'Re-run with --force to overwrite them',
      ExitCode.usage,
    )
  }
  const files = plan.actions.map((a) =>
    a.kind === 'skip' ? a : { kind: a.kind, path: a.path, ...(a.kind === 'edit' ? { note: a.note } : {}) },
  )
  if (say) {
    for (const a of plan.actions) {
      if (a.kind === 'skip') log.dim(`- ${a.path}  ${a.reason}`)
      else log.step(describe(a))
    }
  }
  if (flags.dryRun) {
    if (flags.json) emitJson({ ok: true, dryRun: true, ...summary, files })
    return
  }

  const write = (a: FileAction) => {
    if (a.kind === 'skip') return
    mkdirSync(dirname(join(root, a.path)), { recursive: true })
    writeFileSync(join(root, a.path), a.content)
  }
  // The config edit goes first: when the new file does not load, it is put back and nothing else lands.
  const configEdit = plan.actions.find((a) => a.kind === 'edit' && a.path === configFile)
  if (configEdit && configFile) {
    const original = readFileSync(join(root, configFile), 'utf8')
    write(configEdit)
    const problem = await configProblem(root, added)
    if (problem) {
      writeFileSync(join(root, configFile), original)
      throw new KitError(
        `${configFile} was put back: with the edit, ${problem}`,
        'Add the target by hand',
        ExitCode.failed,
      )
    }
  }
  for (const a of plan.actions) if (a !== configEdit) write(a)
  if (!configEdit) {
    const problem = await configProblem(root, added)
    if (problem) throw new KitError(`kit.config.ts: ${problem}`, undefined, ExitCode.config)
  }

  if (flags.json) emitJson({ ok: true, dryRun: false, ...summary, files })
  else {
    log.success(`added ${added.add} ${added.name}  ${pc.dim(added.dir)}`)
    if (added.next.length) log.dim(`next:\n${added.next.map((n) => `  ${n}`).join('\n')}`)
  }
}
