import type { CommitDetail } from './git'

/**
 * `kit changelog`: Conventional Commits between two refs, grouped for people. The range starts at
 * the newest release tag (PLAN §9.2: `ios/v{version}+{build}`, `{service}/v{version}`), like the
 * release notes. Everything here is pure; the command does the git calls and the file write.
 */

export const SECTIONS = ['Breaking', 'Features', 'Fixes', 'Performance', 'Other'] as const
export type Section = (typeof SECTIONS)[number]

/** Types left out unless `--all` asks for them. */
export const QUIET_TYPES = ['chore', 'test', 'ci', 'style']

/** Any release tag: `v1.2.3`, `ios/v1.4.0+12`, `api/v0.3.0`. `*` crosses `/` in `git describe --match`. */
export const ANY_RELEASE_TAG = '*v[0-9]*'

export interface Entry {
  sha: string
  /** Conventional Commit type; undefined for a subject that is not one. */
  type?: string
  scope?: string
  description: string
  breaking: boolean
}

const SUBJECT = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/

/** A commit as a changelog entry. A subject that is not a Conventional Commit keeps its whole text. */
export function parseCommit(commit: Pick<CommitDetail, 'sha' | 'subject' | 'body'>): Entry {
  const footer = /^BREAKING[ -]CHANGE:/m.test(commit.body)
  const m = SUBJECT.exec(commit.subject)
  if (!m) return { sha: commit.sha, description: commit.subject, breaking: footer }
  return {
    sha: commit.sha,
    type: m[1]!.toLowerCase(),
    ...(m[2] ? { scope: m[2] } : {}),
    description: m[4]!,
    breaking: footer || m[3] === '!',
  }
}

/** The section an entry is listed in; undefined when it is left out. */
export function sectionOf(entry: Entry, all: boolean): Section | undefined {
  if (entry.type === 'chore' && entry.scope === 'release') return undefined
  if (entry.breaking) return 'Breaking'
  if (entry.type === 'feat') return 'Features'
  if (entry.type === 'fix') return 'Fixes'
  if (entry.type === 'perf') return 'Performance'
  if (entry.type && QUIET_TYPES.includes(entry.type) && !all) return undefined
  return 'Other'
}

export interface Group {
  title: Section
  commits: Entry[]
}

/** Commits (newest first) grouped into the non-empty sections, Breaking first. Merges are dropped. */
export function groupCommits(commits: CommitDetail[], opts: { all?: boolean } = {}): Group[] {
  const by = new Map<Section, Entry[]>()
  for (const c of commits) {
    if (c.merge || /^Merge (branch|pull request|remote-tracking branch|tag) /.test(c.subject)) continue
    const entry = parseCommit(c)
    const section = sectionOf(entry, opts.all === true)
    if (!section) continue
    by.set(section, [...(by.get(section) ?? []), entry])
  }
  return SECTIONS.flatMap((title) => (by.has(title) ? [{ title, commits: by.get(title)! }] : []))
}

const line = (e: Entry) => `- ${e.scope ? `**${e.scope}:** ` : ''}${e.description} (${e.sha.slice(0, 7)})`

/** `### <section>` blocks; empty when there is nothing to list. */
export function renderMarkdown(groups: Group[]): string {
  return groups.map((g) => `### ${g.title}\n\n${g.commits.map(line).join('\n')}\n`).join('\n')
}

/** The version in a release tag: `ios/v1.4.0+12` → `1.4.0`, `v0.6.0` → `0.6.0`. */
export function tagVersion(tag: string): string | undefined {
  return tag.match(/(?:^|\/)v(\d+\.\d+\.\d+[\w.-]*)/)?.[1]
}

/** `## 1.4.0 (2026-11-11)`, with the platform or service in front when the changelog is for one. */
export function heading(version: string, date: string, platform?: string): string {
  return `## ${platform ? `${platform} ` : ''}${version} (${date})`
}

export const CHANGELOG_HEADER = '# Changelog\n'

/** The heading version when nothing names one: its section is rewritten, not kept, on each write. */
export const UNRELEASED = 'Unreleased'

/**
 * `text` (undefined: no file yet) with the section put above the newest one. A section with the
 * same heading, whatever its date, is never added twice: the result is undefined. With `replace`
 * (the Unreleased section, which keeps growing) the existing one is rewritten in place instead,
 * keeping whatever follows its entries, and the result is undefined only when that changes nothing.
 */
export function prependSection(
  text: string | undefined,
  head: string,
  body: string,
  opts: { replace?: boolean } = {},
): string | undefined {
  const section = `${head}\n\n${body.trimEnd()}\n`
  if (text === undefined || text.trim() === '') return `${CHANGELOG_HEADER}\n${section}`
  const label = head.replace(/\s*\([^)]*\)$/, '')
  const lines = text.split('\n')
  const existing = lines.findIndex((l) => l === label || l.startsWith(`${label} `))
  if (existing >= 0) {
    if (!opts.replace) return undefined
    // The section is what kit writes: `### <group>` headings, list items and blank lines. It ends
    // at the next `## ` heading or at anything else (link reference definitions, a `---` rule,
    // prose), all of which stays below it.
    const next = lines.findIndex(
      (l, i) => i > existing && (l.startsWith('## ') || !(l.trim() === '' || /^(### |[-*] |\s+\S)/.test(l))),
    )
    const tail = next < 0 ? [] : ['', ...lines.slice(next)]
    const out = [...lines.slice(0, existing), ...section.trimEnd().split('\n'), ...tail].join('\n')
    const done = next < 0 ? `${out}\n` : out
    return done === text ? undefined : done
  }
  const at = lines.findIndex((l) => l.startsWith('## '))
  if (at < 0) return `${text.trimEnd()}\n\n${section}`
  return [...lines.slice(0, at), ...section.split('\n'), ...lines.slice(at)].join('\n')
}
