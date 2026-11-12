/**
 * kit's own release refs. Workflows pin kit's setup action and reusable workflows by commit SHA
 * with the version in a trailing comment (`jordond/kit/…@<sha> # vX.Y.Z`); `kit doctor` compares
 * that comment with the npm pin. `kit init` writes the pins and `kit upgrade` moves them.
 */

/** Overridable for tests (a local bare repo). */
export const kitRepoUrl = (): string => process.env.KIT_REPO_URL || 'https://github.com/jordond/kit.git'

/** Commit SHA of tag `v<version>` in `ls-remote` output; the peeled line of an annotated tag wins. */
export function parseTagSha(lsRemote: string, version: string): string | undefined {
  const ref = `refs/tags/v${version}`
  const rows = lsRemote
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((r): r is [string, string] => r.length === 2)
  const sha = (name: string) => rows.find(([, r]) => r === name)?.[0]
  const found = sha(`${ref}^{}`) ?? sha(ref)
  return found && /^[0-9a-f]{40}$/.test(found) ? found : undefined
}

/** The commit `v<version>` points at, from kit's GitHub repo; undefined offline or for an untagged version. */
export async function tagSha(version: string): Promise<string | undefined> {
  if (!Bun.which('git')) return undefined
  const { runQuiet } = await import('./proc')
  const ref = `refs/tags/v${version}`
  const r = await runQuiet(['git', 'ls-remote', kitRepoUrl(), ref, `${ref}^{}`], {
    env: { GIT_TERMINAL_PROMPT: '0' },
  })
  return r.code === 0 ? parseTagSha(r.output, version) : undefined
}

/** What follows `@` in a `uses:` line. Without a SHA the tag itself is the ref. */
export function usesRef(version: string, sha: string | undefined): string {
  return `${sha ?? `v${version}`} # v${version}`
}

const KIT_USES_LINE = /(jordond\/kit\/[^@\s]+@)\S+([ \t]*#[ \t]*)v?\d+\.\d+\.\d+[^\s]*/g

/** Every `jordond/kit/…@<ref> # vX.Y.Z` in a workflow moved to `sha` and `version`. */
export function repinWorkflow(text: string, version: string, sha: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(KIT_USES_LINE, (_m, head: string, gap: string) => {
    count++
    return `${head}${sha}${gap}v${version}`
  })
  return { text: out, count: out === text ? 0 : count }
}

export const KIT_PACKAGE = '@jordond/kit'

/** Latest published version, from the npm registry (`KIT_REGISTRY` overrides the URL for tests). */
export async function latestVersion(): Promise<string | undefined> {
  const registry = (process.env.KIT_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
  try {
    const res = await fetch(`${registry}/${KIT_PACKAGE}/latest`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return undefined
    const version = ((await res.json()) as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

export interface PinEdit {
  /** The manifest with the new range; equal to the input when the pin is already there. */
  text: string
  from: string
  to: string
}

/**
 * Move the `@jordond/kit` range in a package.json to `version`, keeping its operator (`^`, `~` or
 * none) and the file's formatting. Undefined when there is no pin; `from` without a semver range
 * (`file:`, `workspace:`, a tag) comes back unchanged, for the caller to refuse.
 */
export function bumpPin(manifest: string, version: string): PinEdit | undefined {
  const re = /("@jordond\/kit"\s*:\s*")([^"]*)(")/
  const m = manifest.match(re)
  if (!m) return undefined
  const from = m[2]!
  const range = from.match(/^([\^~]?)v?\d+\.\d+\.\d+\S*$/)
  if (!range) return { text: manifest, from, to: from }
  const to = `${range[1]}${version}`
  return { text: manifest.replace(re, `$1${to}$3`), from, to }
}
