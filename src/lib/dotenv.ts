import { ExitCode, KitError } from './errors'

/**
 * Reading and writing one dotenv line, shared by every kit reader (`loadDotEnv`, `parseDotenv`) and
 * writer (`kit env init`, the output renderer, `kit env rotate`).
 *
 * Two formats, because the files have different consumers:
 * - `env`: the repo `.env`. Bun loads it before kit starts (and expands `$NAME`, `${X}`, `$1`, `$$`
 *   in bare and quoted values alike), and wrangler falls back to it through dotenv-expand.
 * - `vars`: rendered outputs (`.dev.vars`). wrangler reads them with dotenv `parse`: no expansion.
 *
 * Reading (both formats; one line, the text after `KEY=` already trimmed):
 * - A raw value that starts with `#` is empty plus a comment (`KEY= # note`).
 * - Quoted with `'`, `"` or a backtick: the value runs to the closing quote; a `#` inside is part of
 *   it. In double quotes `\n` and `\r` become a newline and a carriage return. Nothing else is an
 *   escape, so a quoted value cannot hold its own quote character.
 * - Unquoted: a ` #` starts a comment.
 * - `env` only: `\$` is a literal `$`. An unescaped `$` is left as written: kit does not expand.
 *
 * Writing produces a line every consumer of that format reads back as the same value:
 * - Bare when possible. Quoted when the value holds a `#` (Bun and dotenv cut a bare value at any
 *   `#`), has whitespace at either end, or starts with a quote character; in the first of `'`, `"`,
 *   backtick the value does not hold (a line's existing style is kept when it fits).
 * - `env` only: every `$` is written `\$`, except one that ends the value (no reader unescapes there).
 * - A multi-line value is double-quoted, newlines as `\n` and carriage returns as `\r`.
 * - Refused (exit 3, naming the key), because some consumer would read something else: a value that
 *   needs quotes and holds all three quote characters or ends in a backslash; a value with a literal
 *   `\n` / `\r` that could only go in double quotes; a multi-line value holding `"`, a literal `\n` /
 *   `\r`, a backslash before a line break or at its end; in `env`, a value ending in `\$`.
 */

export type DotenvFormat = 'env' | 'vars'

const QUOTES = ["'", '"', '`'] as const

/** The value of one dotenv line, given the text after `KEY=` (already trimmed). */
export function dotenvValue(raw: string, format: DotenvFormat): string {
  // `KEY= # note`: the caller's trim ate the space, so the comment arrives first.
  if (raw.startsWith('#')) return ''
  const quoted = /^(['"`])(.*?)\1\s*(?:#.*)?$/.exec(raw)
  let value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '')
  if (quoted?.[1] === '"') {
    // dotenv expands every `\n`; Bun leaves one that follows a backslash. kit never writes that case.
    value =
      format === 'env'
        ? value.replace(/(?<!\\)\\n/g, '\n').replace(/(?<!\\)\\r/g, '\r')
        : value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
  }
  // As Bun does: `\$` is a dollar unless it ends the value.
  if (format === 'env') value = value.replace(/\\\$(?=[\s\S])/g, '$')
  return value
}

/** Bare would be read back differently: a `#`, whitespace at either end, or a leading quote. */
const needsQuotes = (value: string) => /#|^\s|\s$|^['"`]/.test(value)

/**
 * A quote style holds the value when no consumer sees an escape in it: not the quote itself, not a
 * final backslash (it would escape the closing quote for dotenv and Bun), and in double quotes no
 * literal `\n` / `\r`, which are expanded there.
 */
const fits = (value: string, quote: string) =>
  !value.includes(quote) && !value.endsWith('\\') && (quote !== '"' || !/\\[nr]/.test(value))

/**
 * A value as it goes after `KEY=` in a file of `format`; see the rules above. `prefer` is the quote
 * style the line already uses. Throws exit 3 naming `key` (never the value) when no line can hold it.
 */
export function dotenvEncode(key: string, value: string, format: DotenvFormat, prefer?: string): string {
  const refuse = (why: string, hint: string): never => {
    const where = format === 'env' ? '.env' : 'a .dev.vars output'
    throw new KitError(`Cannot write ${key} to ${where}: its value ${why}`, hint, ExitCode.config)
  }
  const other = 'Use a value without that, or store it base64-encoded and decode it where it is used'
  if (format === 'env' && value.endsWith('\\$')) {
    refuse('ends in a backslash and a dollar sign, which Bun and dotenv read differently', other)
  }
  const escaped = format === 'env' ? value.replace(/\$(?=[\s\S])/g, '\\$') : value

  if (/[\r\n]/.test(value)) {
    if (value.includes('"') || /\\[nr]/.test(value) || /\\[\r\n]/.test(value) || value.endsWith('\\')) {
      refuse(
        'is multi-line and holds a double quote or a backslash sequence that a one-line dotenv value cannot carry',
        'Store it base64-encoded and decode it where it is used',
      )
    }
    return `"${escaped.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`
  }
  if (prefer && fits(value, prefer)) return `${prefer}${escaped}${prefer}`
  if (!needsQuotes(value)) return escaped
  const quote = QUOTES.find((q) => fits(value, q))
  if (!quote) {
    refuse(
      value.endsWith('\\')
        ? 'needs quotes and ends in a backslash, which would escape the closing quote'
        : 'needs quotes and no quote style can hold it (it has \', " and `, or a literal \\n next to them)',
      other,
    )
  }
  return `${quote}${escaped}${quote}`
}

/** `KEY=value` (no line ending) for a file of `format`. */
export function dotenvLine(key: string, value: string, format: DotenvFormat, prefer?: string): string {
  return `${key}=${dotenvEncode(key, value, format, prefer)}`
}

export interface DotenvAmbiguity {
  key: string
  /** 1-based line in the file. */
  line: number
  reason: string
  /** How to write the line so every reader agrees. */
  hint: string
}

/**
 * Hand-written `.env` lines that Bun (which loads `.env` before kit starts), dotenv and kit read as
 * different values, so what runs locally and what `kit env push` sends could differ. Names, line
 * numbers and reasons only: values never leave this function. kit's own writers never produce these.
 */
export function dotenvAmbiguities(text: string): DotenvAmbiguity[] {
  const out: DotenvAmbiguity[] = []
  text.split('\n').forEach((full, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(full)
    if (!m) return
    const [, key, raw] = m as unknown as [string, string, string]
    if (!raw || raw.startsWith('#')) return
    const add = (reason: string, hint: string) => out.push({ key, line: i + 1, reason, hint })
    const open = /^(['"`])/.exec(raw)?.[1]
    const quoted = /^(['"`])(.*?)\1\s*(?:#.*)?$/.exec(raw)
    if (open && !quoted) {
      add(
        'opens a quote that does not close on the line (kit reads one line; Bun and dotenv read on)',
        'Put the value on one line, with \\n for line breaks inside double quotes',
      )
      return
    }
    const value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '')
    if (!quoted && /\S#/.test(value)) {
      add(
        'has a # in an unquoted value (Bun and dotenv stop there; kit keeps it)',
        `Quote the value: ${key}='…'`,
      )
    }
    if (/(?<!\\)\$(?=[\s\S])/.test(value)) {
      add(
        'has an unescaped $ (Bun expands it as a variable, also inside quotes; kit keeps it)',
        'Write \\$ for a literal dollar sign',
      )
    }
  })
  return out
}
