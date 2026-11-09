import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'

/**
 * TOML read via smol-toml, and a surgical write that edits one line in place so comments, key
 * order and quoting survive (brewd's version bump did this with a regex per key; this is the
 * general form). Only single-line scalar values can be written.
 */

export type TomlScalar = string | number | boolean

export function parseToml(text: string): Record<string, unknown> {
  return parse(text) as Record<string, unknown>
}

export function readToml(path: string): Record<string, unknown> {
  return parseToml(readFileSync(path, 'utf8'))
}

/** `table` is a dotted table name (`versions`, `a.b`); '' is the root table. */
export function getTomlValue(text: string, table: string, key: string): unknown {
  let node: unknown = parseToml(text)
  for (const part of table ? table.split('.') : []) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  }
  return node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2')

/** `[ "a" . b ]` → 'a.b'; undefined for a line that is not a table header. */
function headerName(line: string): string | undefined {
  const m = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/)
  if (!m) return undefined
  return m[1]!
    .split('.')
    .map((p) => unquote(p))
    .join('.')
}

/** The end index (exclusive) of the value token starting at `i`, or -1 for values this can't edit. */
function valueEnd(line: string, i: number): number {
  const c = line[i]
  if (line.startsWith('"""', i) || line.startsWith("'''", i) || c === '[' || c === '{') return -1
  if (c === '"') {
    for (let j = i + 1; j < line.length; j++) {
      if (line[j] === '\\') j++
      else if (line[j] === '"') return j + 1
    }
    return -1
  }
  if (c === "'") {
    const j = line.indexOf("'", i + 1)
    return j < 0 ? -1 : j + 1
  }
  let j = i
  while (j < line.length && line[j] !== '#' && !/\s/.test(line[j]!)) j++
  return j
}

function encode(value: TomlScalar, original: string): string {
  if (typeof value !== 'string') return String(value)
  if (original.startsWith("'") && !value.includes("'") && !/[\n\r]/.test(value)) return `'${value}'`
  return JSON.stringify(value)
}

/**
 * Set `key` in `[table]` to `value`, changing only that value's characters. A string keeps the
 * existing quote style. Throws when the key isn't there or its value spans lines.
 */
export function setTomlValue(text: string, table: string, key: string, value: TomlScalar): string {
  const lines = text.split('\n')
  let current = ''
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!
    const header = headerName(line)
    if (header !== undefined) {
      current = header
      continue
    }
    if (current !== table) continue
    const m = line.match(/^(\s*)("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)(\s*=\s*)/)
    if (!m || unquote(m[2]!) !== key) continue
    const start = m[0].length
    const end = valueEnd(line, start)
    if (end < 0) throw new Error(`${where(table, key)} is not a single-line value`)
    lines[n] = `${line.slice(0, start)}${encode(value, line.slice(start, end))}${line.slice(end)}`
    const out = lines.join('\n')
    if (getTomlValue(out, table, key) !== value) throw new Error(`Could not set ${where(table, key)}`)
    return out
  }
  throw new Error(`${where(table, key)} not found`)
}

const where = (table: string, key: string) => (table ? `[${table}] ${key}` : key)
