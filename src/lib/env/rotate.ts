import { randomBytes, randomUUID } from 'node:crypto'
import type { KitConfig } from '../../config/schema'
import { dotenvEncode, dotenvLine } from '../dotenv'
import { registerSecret } from '../secrets'
import { GITHUB } from './push'
import type { PushSelection } from './push-run'
import type { EnvGenerate } from './schema'

/**
 * `kit env rotate`: mint a new value for a key whose schema declares `.meta({ generate })`, rewrite
 * its `.env` line, and work out which remotes hold the key. Pure apart from the random source; the
 * command does the file write, the render and the push.
 */

/** A fresh value, registered for redaction before it is returned. */
export function generateValue(spec: EnvGenerate): string {
  const value =
    spec.kind === 'uuid'
      ? randomUUID()
      : randomBytes(spec.length).toString(spec.kind === 'hex' ? 'hex' : 'base64url')
  registerSecret(value)
  return value
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replace the value on `KEY=…` lines and leave everything else as it was: comments (a trailing
 * ` # note` after the value too), order, other keys, `export`, spacing around `=`, the quote style
 * and the file's line endings; the new value is quoted when it needs it. A `#` inside quotes is part of the value, not a comment. A key the
 * file lacks is appended as its own line. A commented `# KEY=` is a comment, not the key.
 */
export function rewriteKey(text: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const re = new RegExp(`^(\\s*(?:export\\s+)?${escapeRe(key)}\\s*=[ \\t]*)(.*)$`)
  let replaced = false
  const lines = text.split('\n').map((line) => {
    const cr = line.endsWith('\r') ? '\r' : ''
    const m = re.exec(cr ? line.slice(0, -1) : line)
    if (!m) return line
    replaced = true
    const rest = m[2]!
    // `KEY= # note`: an empty value and a comment.
    if (rest.startsWith('#')) return `${m[1]!.trimEnd()}${dotenvEncode(value)} ${rest}${cr}`
    // Quoted: the value runs to the closing quote; what follows is blank or a comment.
    const quoted = /^(['"`]).*?\1([ \t]+#.*|[ \t]*)$/.exec(rest)
    if (quoted) return `${m[1]}${dotenvEncode(value, quoted[1])}${quoted[2]}${cr}`
    // Unquoted: the value ends at the first whitespace-then-#, else at trailing whitespace.
    const tail = /[ \t]+#.*$/.exec(rest)?.[0] ?? /[ \t]*$/.exec(rest)?.[0] ?? ''
    return `${m[1]}${dotenvEncode(value)}${tail}${cr}`
  })
  if (replaced) return lines.join('\n')
  const head = text === '' || text.endsWith('\n') ? text : `${text}${eol}`
  return `${head}${dotenvLine(key, value)}${eol}`
}

/** Remotes that hold `key`: worker targets from `env.workerSecrets`, then `github` from `env.githubSecrets`. */
export function destinationsFor(config: KitConfig, key: string): string[] {
  const workers = Object.entries(config.env?.workerSecrets ?? {})
    .filter(([, keys]) => keys.includes(key))
    .map(([target]) => target)
  return config.env?.githubSecrets?.includes(key) ? [...workers, GITHUB] : workers
}

/**
 * The fewest `kit env push` runs that reach every remote holding `keys`, never widening to a remote
 * that holds none of them. Empty when no remote holds any.
 */
export function pushSelections(config: KitConfig, keys: string[]): PushSelection[] {
  const held = new Set(keys.flatMap((k) => destinationsFor(config, k)))
  const github = held.has(GITHUB)
  const all = Object.keys(config.env?.workerSecrets ?? {})
  const workers = all.filter((t) => held.has(t))
  if (!workers.length) return github ? [{ github: true }] : []
  if (workers.length === 1) return [github ? { target: workers[0], github: true } : { target: workers[0] }]
  if (workers.length === all.length) {
    // Bare push also covers GitHub, so it only fits when GitHub holds a key or is not configured.
    return [github || !config.env?.githubSecrets?.length ? {} : { workers: true }]
  }
  return [...workers.map((target) => ({ target })), ...(github ? [{ github: true }] : [])]
}
