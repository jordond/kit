import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dotenvLine, parseEnvKeys } from '../dotenv'
import { parseDotenv, writeAtomic } from './render'
import type { EnvKey, EnvSchema } from './schema'

/**
 * `kit env init` (ported from WhaleSay `env/init.ts`): create `.env` from `.env.example`, backfill
 * keys the example gained since, then ask for required keys that are empty or still a
 * `replace-me…` placeholder. Optional keys are never asked. Values are only ever written to `.env`.
 */

export const PLACEHOLDER_RE = /^replace-me/

/** Replace `KEY=…` in place, or append it. Comments and other lines are kept; the value is quoted when it needs it. */
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
    return dotenvLine(key, value, 'env')
  })
  if (!replaced) {
    if (next.length && next[next.length - 1] === '')
      next.splice(next.length - 1, 0, dotenvLine(key, value, 'env'))
    else next.push(dotenvLine(key, value, 'env'))
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

export interface FillPlan {
  /** `.env` did not exist; it starts as a copy of `.env.example`. */
  created: boolean
  /** Keys copied from `.env.example` that `.env` lacked (none when created). */
  added: string[]
  /** `.env` text after the copy. */
  text: string
}

/**
 * `.env` with every key `.env.example` names: a copy of the example when `.env` is missing,
 * otherwise each missing key appended with the example's value. Existing lines never change, and a
 * commented-out `# KEY=` in `.env` does not count as set (the same rule as `kit doctor`).
 */
export function planFill(example: string, env: string | null): FillPlan {
  if (env === null) return { created: true, added: [], text: example }
  let text = env
  const have = new Set(parseEnvKeys(env))
  const added: string[] = []
  for (const [k, v] of Object.entries(parseDotenv(example, 'env'))) {
    if (have.has(k)) continue
    text = setKey(text, k, v)
    have.add(k)
    added.push(k)
  }
  return { created: false, added, text }
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

/** `kit env`: write `planFill` to `.env` (0600). Undefined without a `.env.example`; nothing is written when nothing changes. */
export function fillEnv(root: string, dryRun = false): FillPlan | undefined {
  const example = readIf(join(root, '.env.example'))
  if (example === null) return undefined
  const plan = planFill(example, readIf(join(root, '.env')))
  if (!dryRun && (plan.created || plan.added.length)) {
    let text = plan.text
    if (text && !text.endsWith('\n')) text += '\n'
    writeAtomic(join(root, '.env'), text)
  }
  return plan
}

export function planInit(root: string, schema: EnvSchema): InitPlan {
  const example = readIf(join(root, '.env.example'))
  const env = readIf(join(root, '.env'))
  const fill =
    example === null ? { created: env === null, added: [], text: env ?? '' } : planFill(example, env)
  const { created, added: backfilled, text } = fill
  const parsed = parseDotenv(text, 'env')
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
  return parseDotenv(text, 'env')
}
