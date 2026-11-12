import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

// `kit changelog` in the release-toolchain fixture (versions.keys.android, TOML 1.4.0) with a
// history of two Android releases and unreleased work on top.

let f: Fixture
let n = 0
const git = (...args: string[]) => {
  // Distinct, increasing commit dates keep `git log` order stable.
  const date = `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
    cwd: f.dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}
const add = (subject: string, body?: string) => {
  n++
  git('commit', '-q', '--allow-empty', '-m', subject, ...(body ? ['-m', body] : []))
  return git('rev-parse', '--short=7', 'HEAD')
}
const read = (p: string) => readFileSync(join(f.dir, p), 'utf8')
/** The date kit put in a heading (its local day; `bun test` itself runs in UTC). */
const dated = (text: string) => text.match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1] ?? 'no date'

const sha: Record<string, string> = {}
beforeEach(() => {
  f = fixture('release-toolchain', [])
  n = 0
  git('init', '-q', '-b', 'main')
  sha.first = add('feat: first screen')
  git('tag', 'android/v1.2.0+7')
  sha.sync = add('feat(sync): offline queue')
  sha.crash = add('fix: crash on rotate')
  add('chore(release): android 1.3.0')
  git('tag', 'android/v1.3.0+9')
  sha.api = add('feat(api): rate limits')
  git('tag', 'api/v0.3.0')
  sha.auth = add('feat(auth)!: passkeys only')
  sha.cold = add('perf: faster cold start')
  sha.deps = add('chore: bump deps')
  sha.docs = add('docs: release steps')
  sha.widgets = add('fix: widget refresh', 'BREAKING CHANGE: needs Android 14')
})
afterEach(() => f.cleanup())

test('default: Markdown on stdout for the range since the last release tag of any kind', async () => {
  const r = await f.kit(['changelog'])
  expect(r.code).toBe(0)
  expect(r.stderr).toBe('')
  expect(r.stdout).toBe(
    [
      '### Breaking',
      '',
      `- widget refresh (${sha.widgets})`,
      `- **auth:** passkeys only (${sha.auth})`,
      '',
      '### Performance',
      '',
      `- faster cold start (${sha.cold})`,
      '',
      '### Other',
      '',
      `- release steps (${sha.docs})`,
      '',
    ].join('\n'),
  )
})

test('--platform uses that platform’s tags; --all adds the chores, never chore(release)', async () => {
  const r = await f.kit(['changelog', '--platform', 'android', '--all', '--json'])
  expect(r.code).toBe(0)
  const doc = JSON.parse(r.stdout) as {
    from: string
    to: string
    sections: { title: string; commits: { description: string; scope?: string; type?: string }[] }[]
  }
  expect(doc.from).toBe('android/v1.3.0+9')
  expect(doc.to).toBe('HEAD')
  expect(doc.sections.map((s) => [s.title, s.commits.map((c) => c.description)])).toEqual([
    ['Breaking', ['widget refresh', 'passkeys only']],
    ['Features', ['rate limits']],
    ['Performance', ['faster cold start']],
    ['Other', ['release steps', 'bump deps']],
  ])
  expect(doc.sections[1]!.commits[0]).toMatchObject({ type: 'feat', scope: 'api', breaking: false })
})

test('--to a tag lists that release: from the tag before it', async () => {
  const r = await f.kit(['changelog', '--platform', 'android', '--to', 'android/v1.3.0+9', '--json'])
  const doc = JSON.parse(r.stdout)
  expect(doc).toMatchObject({ from: 'android/v1.2.0+7', to: 'android/v1.3.0+9' })
  expect(doc.sections.map((s: { title: string }) => s.title)).toEqual(['Features', 'Fixes'])
})

test('--from and --to pick the range; no tag at all lists the whole history', async () => {
  const r = await f.kit(['changelog', '--from', 'android/v1.2.0+7', '--to', 'api/v0.3.0'])
  expect(r.stdout).toBe(
    `### Features\n\n- **api:** rate limits (${sha.api})\n- **sync:** offline queue (${sha.sync})\n\n### Fixes\n\n- crash on rotate (${sha.crash})\n`,
  )
  const all = JSON.parse((await f.kit(['changelog', '--to', 'android/v1.2.0+7', '--json'])).stdout)
  expect(all).toMatchObject({ from: null, to: 'android/v1.2.0+7' })
  expect(all.sections[0].commits.map((c: { description: string }) => c.description)).toEqual(['first screen'])
})

test('nothing since the tag: empty stdout, a note on stderr, empty sections in --json', async () => {
  git('tag', 'android/v1.4.0+10')
  const r = await f.kit(['changelog', '--platform', 'android'])
  expect(r.code).toBe(0)
  expect(r.stdout).toBe('')
  expect(r.stderr).toContain('No changes since android/v1.4.0+10')
  expect(JSON.parse((await f.kit(['changelog', '--platform', 'android', '--json'])).stdout)).toEqual({
    from: 'android/v1.4.0+10',
    to: 'HEAD',
    sections: [],
  })
})

test('--write creates CHANGELOG.md with a dated section for the TOML version, once', async () => {
  const dry = await f.kit(['changelog', '--platform', 'android', '--write', '--dry-run'])
  expect(dry.code).toBe(0)
  const date = dated(dry.stderr)
  expect(dry.stderr).toContain(`would add ## android 1.4.0 (${date}) to CHANGELOG.md`)
  expect(existsSync(join(f.dir, 'CHANGELOG.md'))).toBe(false)

  const r = await f.kit(['changelog', '--platform', 'android', '--write'])
  expect(r.code).toBe(0)
  expect(r.stdout).toBe('')
  expect(r.stderr).toContain(`CHANGELOG.md: added ## android 1.4.0 (${date})`)
  const text = read('CHANGELOG.md')
  expect(text).toStartWith(`# Changelog\n\n## android 1.4.0 (${date})\n\n### Breaking\n\n- widget refresh (`)
  expect(text).toContain('### Features\n\n- **api:** rate limits')

  // Again: the heading is there, so nothing is added.
  const again = await f.kit(['changelog', '--platform', 'android', '--write'])
  expect(again.code).toBe(0)
  expect(again.stderr).toContain('already has ## android 1.4.0')
  expect(read('CHANGELOG.md')).toBe(text)
})

test('--write <file>: a section for an older release goes above the existing ones', async () => {
  writeFileSync(join(f.dir, 'NOTES.md'), '# Notes\n\nIntro.\n\n## android 1.2.0 (2025-12-01)\n\n- first\n')
  const r = await f.kit([
    'changelog',
    '--platform',
    'android',
    '--to',
    'android/v1.3.0+9',
    '--write',
    'NOTES.md',
    '--json',
  ])
  expect(r.code).toBe(0)
  const doc = JSON.parse(r.stdout) as { heading: string }
  const date = dated(doc.heading)
  expect(doc).toMatchObject({
    from: 'android/v1.2.0+7',
    file: 'NOTES.md',
    heading: `## android 1.3.0 (${date})`,
    written: true,
  })
  expect(read('NOTES.md')).toBe(
    [
      '# Notes',
      '',
      'Intro.',
      '',
      `## android 1.3.0 (${date})`,
      '',
      '### Features',
      '',
      `- **sync:** offline queue (${sha.sync})`,
      '',
      '### Fixes',
      '',
      `- crash on rotate (${sha.crash})`,
      '',
      '## android 1.2.0 (2025-12-01)',
      '',
      '- first',
      '',
    ].join('\n'),
  )
  expect(existsSync(join(f.dir, 'CHANGELOG.md'))).toBe(false)
})

test('usage errors: an unknown platform, a stray argument', async () => {
  const bad = await f.kit(['changelog', '--platform', 'windows'])
  expect(bad.code).toBe(2)
  expect(bad.stderr).toContain('Unknown platform "windows"')
  const stray = await f.kit(['changelog', 'NOTES.md'])
  expect(stray.code).toBe(2)
  expect(stray.stderr).toContain('A file name only follows --write')
  const json = await f.kit(['changelog', '--platform', 'windows', '--json'])
  expect(json.code).toBe(2)
  expect(JSON.parse(json.stdout)).toMatchObject({ ok: false })
})
