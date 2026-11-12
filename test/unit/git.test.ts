import { afterEach, beforeEach, expect, describe as group, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  changedFiles,
  currentBranch,
  defaultBase,
  describe,
  dirtyFiles,
  isClean,
  logSince,
  mergeBase,
  push,
  stagedFiles,
  tag,
} from '../../src/lib/git'

let dir: string

const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const commit = (file: string, subject: string) => {
  writeFileSync(join(dir, file), subject)
  git('add', file)
  git('commit', '-q', '-m', subject)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kit-git-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'kit@example.com')
  git('config', 'user.name', 'kit')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'tag.gpgsign', 'false')
  commit('a.txt', 'feat: first')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

group('git', () => {
  test('isClean and dirtyFiles see modified and untracked files', async () => {
    expect(await isClean(dir)).toBe(true)
    writeFileSync(join(dir, 'b.txt'), 'new')
    expect(await isClean(dir)).toBe(false)
    expect(await dirtyFiles(dir)).toEqual(['?? b.txt'])
  })

  test('stagedFiles lists only staged paths', async () => {
    writeFileSync(join(dir, 'b.txt'), 'new')
    writeFileSync(join(dir, 'c.txt'), 'new')
    git('add', 'b.txt')
    expect(await stagedFiles(dir)).toEqual(['b.txt'])
  })

  test('stagedFiles returns non-ASCII paths verbatim, not quoted', async () => {
    writeFileSync(join(dir, 'café.txt'), 'new')
    writeFileSync(join(dir, 'a b.txt'), 'new')
    git('add', 'café.txt', 'a b.txt')
    expect((await stagedFiles(dir)).sort()).toEqual(['a b.txt', 'café.txt'])
  })

  test('read-only calls return stdout only, not git’s stderr', async () => {
    // GIT_TRACE makes git write trace lines to stderr; they must not end up in the result.
    const before = process.env.GIT_TRACE
    process.env.GIT_TRACE = '1'
    try {
      expect(await currentBranch(dir)).toBe('main')
      expect((await logSince(undefined, { cwd: dir })).map((c) => c.subject)).toEqual(['feat: first'])
    } finally {
      if (before === undefined) delete process.env.GIT_TRACE
      else process.env.GIT_TRACE = before
    }
  })

  test('currentBranch', async () => {
    expect(await currentBranch(dir)).toBe('main')
    git('checkout', '-q', '-b', 'release/1.0')
    expect(await currentBranch(dir)).toBe('release/1.0')
  })

  test('describe --match picks the nearest matching tag, undefined when none', async () => {
    expect(await describe('ios/v*', { cwd: dir })).toBeUndefined()
    await tag('ios/v1.0.0', { cwd: dir })
    commit('b.txt', 'fix: second')
    await tag('android/v1.0.0', { cwd: dir, message: 'Android 1.0.0' })
    commit('c.txt', 'feat: third')
    expect(await describe('ios/v*', { cwd: dir })).toBe('ios/v1.0.0')
    expect(await describe('android/v*', { cwd: dir })).toBe('android/v1.0.0')
    expect(await describe('ios/v*', { cwd: dir, exact: false })).toMatch(/^ios\/v1\.0\.0-2-g[0-9a-f]+$/)
  })

  test('logSince lists commits after a ref, newest first, optionally by path', async () => {
    await tag('v1', { cwd: dir })
    commit('b.txt', 'fix: second')
    commit('c.txt', 'feat: third')
    expect((await logSince('v1', { cwd: dir })).map((c) => c.subject)).toEqual(['feat: third', 'fix: second'])
    expect((await logSince('v1', { cwd: dir, paths: ['b.txt'] })).map((c) => c.subject)).toEqual([
      'fix: second',
    ])
    const all = await logSince(undefined, { cwd: dir })
    expect(all).toHaveLength(3)
    expect(all[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('tag on an existing name throws with git’s message', async () => {
    await tag('v1', { cwd: dir })
    await expect(tag('v1', { cwd: dir })).rejects.toThrow('git tag v1 exited with 128')
  })

  test('push sends refs to the remote', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'kit-git-remote-'))
    try {
      Bun.spawnSync(['git', 'init', '-q', '--bare', remote])
      git('remote', 'add', 'origin', remote)
      await tag('v1', { cwd: dir })
      await push(['main', 'v1'], { cwd: dir })
      const r = Bun.spawnSync(['git', 'tag'], { cwd: remote, stdout: 'pipe' })
      expect(r.stdout.toString().trim()).toBe('v1')
    } finally {
      rmSync(remote, { recursive: true, force: true })
    }
  })
})

group('changedFiles (--affected)', () => {
  test('defaultBase: origin/HEAD, then origin/main, then main, then nothing', async () => {
    expect(await defaultBase(dir)).toBe('main')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    expect(await defaultBase(dir)).toBe('origin/main')
    git('update-ref', 'refs/remotes/origin/develop', 'HEAD')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    expect(await defaultBase(dir)).toBe('origin/develop')
    git('checkout', '-q', '-b', 'feature')
    git('branch', '-q', '-D', 'main')
    git('symbolic-ref', '-d', 'refs/remotes/origin/HEAD')
    git('update-ref', '-d', 'refs/remotes/origin/main')
    expect(await defaultBase(dir)).toBeUndefined()
  })

  test('mergeBase: the fork point, undefined for an unknown ref', async () => {
    const fork = git('rev-parse', 'HEAD')
    git('checkout', '-q', '-b', 'feature')
    commit('b.txt', 'feat: branch')
    git('checkout', '-q', 'main')
    commit('c.txt', 'feat: main moved on')
    git('checkout', '-q', 'feature')
    expect(await mergeBase('main', dir)).toBe(fork)
    expect(await mergeBase('nope', dir)).toBeUndefined()
  })

  test('nothing changed on the base itself', async () => {
    expect(await changedFiles(dir)).toEqual({ base: 'main', files: [] })
  })

  test('commits on the branch plus staged, unstaged, untracked and deleted files', async () => {
    commit('gone.txt', 'feat: to delete')
    git('checkout', '-q', '-b', 'feature')
    mkdirSync(join(dir, 'sub'))
    commit('sub/committed.txt', 'feat: committed')
    // main moving on does not count: only what the branch changed since the fork.
    git('checkout', '-q', '--detach', 'main')
    commit('main-only.txt', 'feat: main moved on')
    git('branch', '-q', '-f', 'main', 'HEAD')
    git('checkout', '-q', 'feature')
    writeFileSync(join(dir, 'staged.txt'), 'staged')
    git('add', 'staged.txt')
    writeFileSync(join(dir, 'a.txt'), 'unstaged edit')
    writeFileSync(join(dir, 'untracked é.txt'), 'new')
    rmSync(join(dir, 'gone.txt'))
    expect(await changedFiles(dir)).toEqual({
      base: 'main',
      files: ['a.txt', 'gone.txt', 'staged.txt', 'sub/committed.txt', 'untracked é.txt'],
    })
  })

  test('ignored files do not count; an explicit base is used as given', async () => {
    commit('.gitignore', 'build/\n')
    commit('b.txt', 'feat: second')
    mkdirSync(join(dir, 'build'))
    writeFileSync(join(dir, 'build/out.txt'), 'x')
    expect(await changedFiles(dir, 'HEAD~1')).toEqual({ base: 'HEAD~1', files: ['b.txt'] })
  })

  test('an unknown base, or no repo at all, is undefined (callers run everything)', async () => {
    expect(await changedFiles(dir, 'origin/nope')).toBeUndefined()
    const bare = mkdtempSync(join(tmpdir(), 'kit-nogit-'))
    try {
      expect(await changedFiles(bare)).toBeUndefined()
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
