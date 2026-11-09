import { runCapture } from './proc'

/** Files staged for commit (added, copied, modified, renamed), repo-relative. */
export async function stagedFiles(cwd = '.'): Promise<string[]> {
  const { code, stdout } = await runCapture(
    ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd },
  )
  if (code !== 0) throw new Error('git diff --cached failed')
  return stdout.split('\n').filter(Boolean)
}
