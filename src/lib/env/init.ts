import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDotenv, writeAtomic } from './render'
import type { EnvKey, EnvSchema } from './schema'

/**
 * `kit env init` (ported from WhaleSay `env/init.ts`): create `.env` from `.env.example`, backfill
 * keys the example gained since, then ask for required keys that are empty or still a
 * `replace-me…` placeholder. Optional keys are never asked. Values are only ever written to `.env`.
 */

export const PLACEHOLDER_RE = /^replace-me/

/** Replace `KEY=…` in place, or append it. Comments and other lines are kept. */
export function setKey(text: string, key: string, value: string): string {
  const lines = text.split('\n')
  let replaced = false
  const next = lines.map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line
    const k = trimmed
      .slice(0, trimmed.indexOf('='))
      .replace(/^export\s+/, '')
      .trim()
    if (k !== key) return line
    replaced = true
    return `${key}=${value}`
  })
  if (!replaced) {
    if (next.length && next[next.length - 1] === '') next.splice(next.length - 1, 0, `${key}=${value}`)
    else next.push(`${key}=${value}`)
  }
  return next.join('\n')
}

export interface InitPlan {
  /** `.env` did not exist; it starts as a copy of `.env.example` (or empty). */
  created: boolean
  /** Keys copied from `.env.example` that `.env` lacked. */
  backfilled: string[]
  /** Required keys that are empty or placeholders. */
  ask: EnvKey[]
  /** `.env` text after copy and backfill, before answers. */
  text: string
}

export function planInit(root: string, schema: EnvSchema): InitPlan {
  const envPath = join(root, '.env')
  const examplePath = join(root, '.env.example')
  const example = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : null
  const created = !existsSync(envPath)
  let text = created ? (example ?? '') : readFileSync(envPath, 'utf8')
  const parsed = parseDotenv(text)
  const backfilled: string[] = []
  if (example !== null && !created) {
    for (const [k, v] of Object.entries(parseDotenv(example))) {
      if (k in parsed) continue
      text = setKey(text, k, v)
      parsed[k] = v
      backfilled.push(k)
    }
  }
  const ask = schema.keys.filter((k) => {
    if (!k.required) return false
    const current = parsed[k.name] ?? ''
    return current === '' || PLACEHOLDER_RE.test(current)
  })
  return { created, backfilled, ask, text }
}

/** Apply answers and write `.env` (0600). Returns the parsed result. */
export function applyInit(
  root: string,
  plan: InitPlan,
  answers: Record<string, string>,
): Record<string, string> {
  let text = plan.text
  for (const [k, v] of Object.entries(answers)) text = setKey(text, k, v)
  if (text && !text.endsWith('\n')) text += '\n'
  writeAtomic(join(root, '.env'), text)
  return parseDotenv(text)
}
