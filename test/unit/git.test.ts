import { afterEach, beforeEach, describe as group, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  currentBranch,
  describe,
  dirtyFiles,
  isClean,
  logSince,
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
