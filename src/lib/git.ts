import { posix } from 'node:path'
import { ProcError, runCapture, runPiped } from './proc'

/**
 * Files staged for commit (added, copied, modified, renamed), relative to `cwd` (the kit root),
 * which is where the tools that get them run. Staged files outside `cwd`, when it sits below the
 * git toplevel, are left out: no target owns them and no tool here could be handed them.
 */
export async function stagedFiles(cwd = '.'): Promise<string[]> {
  const { code, stdout } = await runCapture(
    ['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', '--relative'],
    { cwd },
  )
  if (code !== 0) throw new Error('git diff --cached failed')
  // -z: NUL-separated and unquoted, so non-ASCII and odd paths come through verbatim.
  return stdout.split('\0').filter(Boolean)
}

/** Read-only git call: stdout on success, ProcError (with git's message) otherwise. */
async function read(args: string[], cwd: string): Promise<string> {
  const cmd = ['git', ...args]
  const { code, stdout, stderr } = await runPiped(cmd, { cwd })
  if (code !== 0) throw new ProcError(cmd, code, `${stdout}${stderr}`)
  return stdout
}

/** Uncommitted changes (tracked or untracked), as `git status --porcelain` lines. */
export async function dirtyFiles(cwd = '.'): Promise<string[]> {
  const { code, stdout } = await runCapture(['git', 'status', '--porcelain'], { cwd })
  if (code !== 0) throw new Error('git status failed')
  return stdout.split('\n').filter(Boolean)
}

export async function isClean(cwd = '.'): Promise<boolean> {
  return (await dirtyFiles(cwd)).length === 0
}

/** Branch name, or 'HEAD' when detached. */
export async function currentBranch(cwd = '.'): Promise<string> {
  return (await read(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
}

/**
 * Nearest tag reachable from `ref` matching the glob `match` (`ios/v*`), or undefined when none
 * does. `exact` asks for the tag name only (`--abbrev=0`), without the `-N-gSHA` suffix.
 */
export async function describe(
  match: string,
  opts: { cwd?: string; ref?: string; exact?: boolean } = {},
): Promise<string | undefined> {
  const cmd = ['git', 'describe', '--tags', '--match', match]
  if (opts.exact !== false) cmd.push('--abbrev=0')
  if (opts.ref) cmd.push(opts.ref)
  const { code, stdout, stderr } = await runPiped(cmd, { cwd: opts.cwd ?? '.' })
  if (code === 0) return stdout.trim()
  if (/No names found|No tags can describe|cannot describe/i.test(stderr)) return undefined
  throw new ProcError(cmd, code, `${stdout}${stderr}`)
}

export interface Commit {
  sha: string
  subject: string
}

/** Commits after `since` up to HEAD (all of history when undefined), newest first, optionally limited to paths. */
export async function logSince(
  since: string | undefined,
  opts: { cwd?: string; paths?: string[] } = {},
): Promise<Commit[]> {
  const range = since ? `${since}..HEAD` : 'HEAD'
  const args = ['log', '--format=%H%x09%s', range]
  if (opts.paths?.length) args.push('--', ...opts.paths)
  const out = await read(args, opts.cwd ?? '.')
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
    })
}

/** Create a tag at HEAD (or `ref`); annotated when `message` is given. */
export async function tag(
  name: string,
  opts: { cwd?: string; message?: string; ref?: string } = {},
): Promise<void> {
  const args = opts.message ? ['tag', '-a', name, '-m', opts.message] : ['tag', name]
  if (opts.ref) args.push(opts.ref)
  await read(args, opts.cwd ?? '.')
}

/** Push refs (branches or tags) to `remote`. */
export async function push(refs: string[], opts: { cwd?: string; remote?: string } = {}): Promise<void> {
  await read(['push', opts.remote ?? 'origin', ...refs], opts.cwd ?? '.')
}

/** Whether `ref` names a commit in this repo. */
async function refExists(ref: string, cwd: string): Promise<boolean> {
  const { code } = await runPiped(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })
  return code === 0
}

/**
 * The ref `--affected` compares against when no `--base` is given: `origin/<default branch>` (from
 * `refs/remotes/origin/HEAD`), else `origin/main`, else `main`. Undefined when none of them exists.
 */
export async function defaultBase(cwd = '.'): Promise<string | undefined> {
  const head = await runPiped(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd,
  })
  const remote = head.code === 0 ? head.stdout.trim() : ''
  for (const ref of [...(remote ? [remote] : []), 'origin/main', 'main']) {
    if (await refExists(ref, cwd)) return ref
  }
  return undefined
}

/** Where HEAD forked from `base`, or undefined when `base` is unknown or shares no history. */
export async function mergeBase(base: string, cwd = '.'): Promise<string | undefined> {
  if (!(await refExists(base, cwd))) return undefined
  const { code, stdout } = await runPiped(['git', 'merge-base', base, 'HEAD'], { cwd })
  return code === 0 && stdout.trim() ? stdout.trim() : undefined
}

export interface Changed {
  /** The ref compared against (`origin/main`). */
  base: string
  /**
   * Paths relative to `cwd`, sorted, without duplicates. Deleted files count, and a moved file
   * lists both its old and new path. A change outside `cwd` (kit root below the git toplevel)
   * starts with `../`.
   */
  files: string[]
  /** HEAD is the fork point itself: nothing was committed since the base (the default branch, a new branch). */
  headIsBase: boolean
}

/**
 * Files that differ from where HEAD forked from `base` (default `defaultBase`): commits on the
 * branch, plus staged, unstaged and untracked files, anywhere in the git repo. Undefined when the
 * base cannot be resolved, which callers must treat as "everything changed".
 */
export async function changedFiles(cwd = '.', base?: string): Promise<Changed | undefined> {
  const ref = base ?? (await defaultBase(cwd))
  const fork = ref ? await mergeBase(ref, cwd) : undefined
  if (!ref || !fork) return undefined
  // From the toplevel: a change outside the kit root (root lockfile, .github/) must not be dropped.
  const top = (await read(['rev-parse', '--show-toplevel'], cwd)).trim()
  const prefix = (await read(['rev-parse', '--show-prefix'], cwd)).trim().replace(/\/$/, '')
  const head = (await read(['rev-parse', 'HEAD'], cwd)).trim()
  // --no-renames: a move out of one target's dir into another's changes both.
  const diff = ['diff', '--name-only', '-z', '--no-renames']
  const lists = await Promise.all([
    // Working tree against the fork point: committed and unstaged changes to tracked files.
    read([...diff, fork], top),
    // The index too: a staged change reverted in the working tree shows up only here.
    read([...diff, '--cached', fork], top),
    read(['ls-files', '--others', '--exclude-standard', '-z'], top),
  ])
  const files = new Set(
    lists.flatMap((out) => out.split('\0').filter(Boolean)).map((f) => posix.relative(prefix, f)),
  )
  return { base: ref, files: [...files].sort(), headIsBase: head === fork }
}

// changelog
export interface CommitDetail extends Commit {
  body: string
  /** More than one parent. */
  merge: boolean
}

/** Like `logSince`, up to `to` instead of HEAD, with each commit's body and whether it is a merge. */
export async function logRange(
  from: string | undefined,
  to = 'HEAD',
  opts: { cwd?: string } = {},
): Promise<CommitDetail[]> {
  const range = from ? `${from}..${to}` : to
  const out = await read(['log', '--format=%H%x1f%P%x1f%s%x1f%b%x1e', range, '--'], opts.cwd ?? '.')
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha = '', parents = '', subject = '', body = ''] = record.split('\x1f')
      return { sha, subject, body: body.trim(), merge: parents.trim().split(/\s+/).length > 1 }
    })
}

/** Whether `ref` names a commit (`HEAD~1` of a root or shallow-boundary commit does not). */
export async function hasCommit(ref: string, cwd = '.'): Promise<boolean> {
  const cmd = ['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]
  return (await runPiped(cmd, { cwd })).code === 0
}

/** A shallow clone (`fetch-depth: 1`): history, and usually the tags, are cut off. */
export async function isShallow(cwd = '.'): Promise<boolean> {
  return (await read(['rev-parse', '--is-shallow-repository'], cwd)).trim() === 'true'
}
