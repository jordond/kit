import { ProcError, runCapture, runPiped } from './proc'

/** Files staged for commit (added, copied, modified, renamed), repo-relative. */
export async function stagedFiles(cwd = '.'): Promise<string[]> {
  const { code, stdout } = await runCapture(
    ['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
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
