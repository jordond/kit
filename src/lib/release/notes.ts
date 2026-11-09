import { describe, logSince } from '../git'

/**
 * Release notes and tags (PLAN §9.2).
 * - mobile tags: `ios/v{version}+{build}`, `android/v{version}+{code}`; services: `{name}/v{version}`.
 * - notes: commit subjects since the newest `<prefix>/v*` tag; without one, the last 20 commits.
 */

export const FALLBACK_COMMITS = 20
/** A tag with a long gap behind it would otherwise produce pages of notes. */
const MAX_COMMITS = 100
export const PLAY_NOTES_MAX = 500

export function mobileTag(platform: 'ios' | 'android', version: string, build: string | number): string {
  return `${platform}/v${version}+${build}`
}

export function serviceTag(name: string, version: string): string {
  return `${name}/v${version}`
}

export async function releaseNotes(
  prefix: string,
  cwd: string,
): Promise<{ since: string | undefined; notes: string }> {
  const since = await describe(`${prefix}/v*`, { cwd })
  const commits = await logSince(since, { cwd })
  const picked = commits.slice(0, since ? MAX_COMMITS : FALLBACK_COMMITS)
  return { since, notes: picked.map((c) => `- ${c.subject}`).join('\n') }
}

/** Keep whole lines that fit in `max` chars; hard-truncate with an ellipsis if even the first doesn't. */
export function clampNotes(notes: string, max: number): string {
  if (notes.length <= max) return notes
  const kept: string[] = []
  let len = 0
  for (const line of notes.split('\n')) {
    const add = (kept.length ? 1 : 0) + line.length
    if (len + add > max) break
    kept.push(line)
    len += add
  }
  return kept.length ? kept.join('\n') : `${notes.slice(0, max - 1)}…`
}
