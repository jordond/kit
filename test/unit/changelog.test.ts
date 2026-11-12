import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANY_RELEASE_TAG,
  CHANGELOG_HEADER,
  groupCommits,
  heading,
  parseCommit,
  prependSection,
  renderMarkdown,
  tagVersion,
} from '../../src/lib/changelog'
import { type CommitDetail, describe as gitDescribe, hasCommit, isShallow, logRange } from '../../src/lib/git'

const commit = (subject: string, over: Partial<CommitDetail> = {}): CommitDetail => ({
  sha: 'abcdef0123456789',
  subject,
  body: '',
  merge: false,
  ...over,
})

describe('parseCommit', () => {
  test('type, scope, description', () => {
    expect(parseCommit(commit('feat(env): push every worker'))).toEqual({
      sha: 'abcdef0123456789',
      type: 'feat',
      scope: 'env',
      description: 'push every worker',
      breaking: false,
    })
    expect(parseCommit(commit('Fix: typo'))).toMatchObject({ type: 'fix', description: 'typo' })
  })

  test('`!` and a BREAKING CHANGE footer mark a breaking change', () => {
    expect(parseCommit(commit('feat!: drop node')).breaking).toBe(true)
    expect(parseCommit(commit('refactor(cli)!: rename flag')).breaking).toBe(true)
    expect(parseCommit(commit('fix: x', { body: 'why\n\nBREAKING CHANGE: config moved' })).breaking).toBe(
      true,
    )
    expect(parseCommit(commit('fix: x', { body: 'BREAKING-CHANGE: y' })).breaking).toBe(true)
    expect(parseCommit(commit('fix: not a BREAKING CHANGE: really')).breaking).toBe(false)
  })

  test('a subject that is not a Conventional Commit keeps its text', () => {
    expect(parseCommit(commit('Update the readme'))).toEqual({
      sha: 'abcdef0123456789',
      description: 'Update the readme',
      breaking: false,
    })
  })
})

describe('groupCommits', () => {
  const log = [
    commit('feat(ios): widgets'),
    commit('fix: crash on launch'),
    commit('perf: faster cold start'),
    commit('docs: readme'),
    commit('chore: bump deps'),
    commit('test: more cases'),
    commit('ci: cache'),
    commit('style: format'),
    commit('chore(release): ios 1.4.0'),
    commit("Merge branch 'main' into feature"),
    commit('feat: from a merge commit', { merge: true }),
    commit('feat(api)!: new auth'),
    commit('Update the readme'),
    commit('fix: second'),
  ]
  const titles = (all = false) =>
    groupCommits(log, { all }).map((g) => [g.title, g.commits.map((c) => c.description)])

  test('Breaking first, then Features, Fixes, Performance, Other; noise and merges dropped', () => {
    expect(titles()).toEqual([
      ['Breaking', ['new auth']],
      ['Features', ['widgets']],
      ['Fixes', ['crash on launch', 'second']],
      ['Performance', ['faster cold start']],
      ['Other', ['readme', 'Update the readme']],
    ])
  })

  test('--all adds chore, test, ci and style to Other; never chore(release) or merges', () => {
    expect(titles(true).at(-1)).toEqual([
      'Other',
      ['readme', 'bump deps', 'more cases', 'cache', 'format', 'Update the readme'],
    ])
  })

  test('a breaking chore is listed even without --all', () => {
    expect(groupCommits([commit('chore!: drop bun 1.2')]).map((g) => g.title)).toEqual(['Breaking'])
  })

  test('no commits, no sections', () => {
    expect(groupCommits([])).toEqual([])
    expect(renderMarkdown([])).toBe('')
  })

  test('renderMarkdown: a block per section, scope in bold, short SHA', () => {
    expect(renderMarkdown(groupCommits(log.slice(0, 2)))).toBe(
      '### Features\n\n- **ios:** widgets (abcdef0)\n\n### Fixes\n\n- crash on launch (abcdef0)\n',
    )
  })
})

describe('headings and --write', () => {
  test('tagVersion reads kit release tags', () => {
    expect(tagVersion('ios/v1.4.0+12')).toBe('1.4.0')
    expect(tagVersion('api/v0.3.0')).toBe('0.3.0')
    expect(tagVersion('v0.6.0')).toBe('0.6.0')
    expect(tagVersion('v2.0.0-rc.1')).toBe('2.0.0-rc.1')
    expect(tagVersion('HEAD')).toBeUndefined()
    expect(tagVersion('review/vendor')).toBeUndefined()
  })

  test('heading', () => {
    expect(heading('1.4.0', '2026-11-11')).toBe('## 1.4.0 (2026-11-11)')
    expect(heading('1.4.0', '2026-11-11', 'ios')).toBe('## ios 1.4.0 (2026-11-11)')
  })

  const body = '### Fixes\n\n- crash (abcdef0)\n'

  test('a new file gets the header and the section', () => {
    expect(prependSection(undefined, '## 1.0.0 (2026-01-01)', body)).toBe(
      `${CHANGELOG_HEADER}\n## 1.0.0 (2026-01-01)\n\n${body}`,
    )
  })

  test('a newer section goes above the newest, below the intro', () => {
    const first = prependSection(undefined, '## 1.0.0 (2026-01-01)', body)!
    const intro = first.replace(CHANGELOG_HEADER, `${CHANGELOG_HEADER}\nAll notable changes.\n`)
    const second = prependSection(intro, '## 1.1.0 (2026-02-01)', '### Features\n\n- widgets (1234567)\n')
    expect(second).toBe(
      `# Changelog\n\nAll notable changes.\n\n## 1.1.0 (2026-02-01)\n\n### Features\n\n- widgets (1234567)\n\n## 1.0.0 (2026-01-01)\n\n${body}`,
    )
  })

  test('the same version is never added twice, whatever the date', () => {
    const first = prependSection(undefined, '## 1.0.0 (2026-01-01)', body)!
    expect(prependSection(first, '## 1.0.0 (2026-03-03)', body)).toBeUndefined()
    expect(prependSection('# Changelog\n\n## 1.0.0\n\n- x\n', '## 1.0.0 (2026-03-03)', body)).toBeUndefined()
    // 1.0.0 is not 1.0.01, and ios 1.0.0 is not 1.0.0.
    expect(prependSection(first, '## 1.0.01 (2026-03-03)', body)).toBeDefined()
    expect(prependSection(first, '## ios 1.0.0 (2026-03-03)', body)).toBeDefined()
  })

  test('replace: an Unreleased section is rewritten in place, and only when it changes', () => {
    const released = '## 1.0.0 (2026-01-01)\n\n- first\n'
    const first = prependSection(`# Changelog\n\n${released}`, '## Unreleased (2026-02-01)', body, {
      replace: true,
    })!
    expect(first).toBe(`# Changelog\n\n## Unreleased (2026-02-01)\n\n${body}\n${released}`)
    // The same changes on the same day: nothing to write.
    expect(prependSection(first, '## Unreleased (2026-02-01)', body, { replace: true })).toBeUndefined()
    // More commits later: the one section is replaced, the release below it stays.
    const more = '### Features\n\n- widgets (1234567)\n\n### Fixes\n\n- crash (abcdef0)\n'
    const second = prependSection(first, '## Unreleased (2026-02-03)', more, { replace: true })
    expect(second).toBe(`# Changelog\n\n## Unreleased (2026-02-03)\n\n${more}\n${released}`)
    expect(second!.match(/^## Unreleased/gm)).toHaveLength(1)
    // As the only section, and for a platform.
    const only = prependSection(undefined, '## ios Unreleased (2026-02-01)', body, { replace: true })!
    expect(prependSection(only, '## ios Unreleased (2026-02-02)', more, { replace: true })).toBe(
      `# Changelog\n\n## ios Unreleased (2026-02-02)\n\n${more}`,
    )
    // Without replace (a version) the rule stays: never twice.
    expect(prependSection(first, '## Unreleased (2026-02-03)', more)).toBeUndefined()
  })

  test('replace keeps what follows the last section: link references, or a rule and prose', () => {
    const more = '### Features\n\n- widgets (1234567)\n'
    const refs = '[1.0.0]: https://example.com/compare/v0.9.0...v1.0.0\n[0.9.0]: https://example.com/v0.9.0\n'
    const prose = '---\n\nGenerated by `kit changelog`.\n\nOlder releases live in the wiki.\n'
    for (const trailer of [refs, prose]) {
      // Unreleased as the only section, then as the last of two.
      for (const above of ['', '## 1.0.0 (2026-01-01)\n\n- first\n\n']) {
        const file = `# Changelog\n\n${above}## Unreleased (2026-02-01)\n\n${body}\n${trailer}`
        const out = prependSection(file, '## Unreleased (2026-02-03)', more, { replace: true })
        expect(out).toBe(`# Changelog\n\n${above}## Unreleased (2026-02-03)\n\n${more}\n${trailer}`)
        // Unchanged entries: nothing to write, trailer or not.
        expect(prependSection(file, '## Unreleased (2026-02-01)', body, { replace: true })).toBeUndefined()
      }
    }
    // A multi-group section with wrapped items is still replaced whole.
    const long = '### Features\n\n- one (1111111)\n  wrapped line\n\n### Fixes\n\n* two (2222222)\n'
    expect(
      prependSection(
        `# Changelog\n\n## Unreleased (2026-02-01)\n\n${long}\n${refs}`,
        '## Unreleased (2026-02-03)',
        more,
        {
          replace: true,
        },
      ),
    ).toBe(`# Changelog\n\n## Unreleased (2026-02-03)\n\n${more}\n${refs}`)
  })

  test('a file without sections gains one at the end', () => {
    expect(prependSection('# Changes\n\nIntro.\n', '## 1.0.0 (2026-01-01)', body)).toBe(
      `# Changes\n\nIntro.\n\n## 1.0.0 (2026-01-01)\n\n${body}`,
    )
  })
})

describe('ranges in a git repo', () => {
  let repo = ''
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }
  const add = (subject: string, body?: string) =>
    git('commit', '-q', '--allow-empty', '-m', subject, ...(body ? ['-m', body] : []))

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'kit-changelog-'))
    git('init', '-q', '-b', 'main')
    add('feat: first')
    git('tag', 'ios/v1.0.0+1')
    add('fix(ios): crash')
    git('tag', 'api/v0.3.0')
    add('feat: widgets', 'Details.\n\nBREAKING CHANGE: needs iOS 18')
    git('checkout', '-q', '-b', 'side')
    add('fix: on a branch')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', 'side', '-m', "Merge branch 'side'")
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  test('logRange: subjects, bodies and merges, newest first', async () => {
    const commits = await logRange('ios/v1.0.0+1', 'HEAD', { cwd: repo })
    // The branch commits share a timestamp, so their order is git's to pick.
    expect(commits.map((c) => `${c.subject} ${c.merge}`).sort()).toEqual([
      "Merge branch 'side' true",
      'feat: widgets false',
      'fix(ios): crash false',
      'fix: on a branch false',
    ])
    expect(commits[0]!.subject).toBe("Merge branch 'side'")
    const widgets = commits.find((c) => c.subject === 'feat: widgets')!
    expect(widgets.body).toBe('Details.\n\nBREAKING CHANGE: needs iOS 18')
    expect(widgets.sha).toMatch(/^[0-9a-f]{40}$/)
    expect((await logRange('ios/v1.0.0+1', 'api/v0.3.0', { cwd: repo })).map((c) => c.subject)).toEqual([
      'fix(ios): crash',
    ])
    expect((await logRange(undefined, 'ios/v1.0.0+1', { cwd: repo })).map((c) => c.subject)).toEqual([
      'feat: first',
    ])
  })

  test('the last release tag: any scheme, or one platform', async () => {
    expect(await gitDescribe(ANY_RELEASE_TAG, { cwd: repo })).toBe('api/v0.3.0')
    expect(await gitDescribe('ios/v*', { cwd: repo })).toBe('ios/v1.0.0+1')
    expect(await gitDescribe(ANY_RELEASE_TAG, { cwd: repo, ref: 'api/v0.3.0~1' })).toBe('ios/v1.0.0+1')
  })

  test('hasCommit and isShallow', async () => {
    expect(await hasCommit('ios/v1.0.0+1', repo)).toBe(true)
    // The first commit has nothing before it; a ref that does not exist is not a commit.
    expect(await hasCommit('ios/v1.0.0+1~1', repo)).toBe(false)
    expect(await hasCommit('no-such-ref', repo)).toBe(false)
    expect(await isShallow(repo)).toBe(false)
  })

  test('grouped from the tag: the footer makes it breaking, the merge is dropped', async () => {
    const groups = groupCommits(await logRange('ios/v1.0.0+1', 'HEAD', { cwd: repo }))
    expect(groups.map((g) => [g.title, g.commits.map((c) => c.description).sort()])).toEqual([
      ['Breaking', ['widgets']],
      ['Fixes', ['crash', 'on a branch']],
    ])
  })
})
