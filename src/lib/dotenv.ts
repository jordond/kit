import { ExitCode, KitError } from './errors'

/**
 * Reading and writing one dotenv line, shared by every kit reader (`loadDotEnv`, `parseDotenv`) and
 * writer (`kit env init`, the output renderer, `kit env rotate`). The rules are the subset the
 * `dotenv` package (which wrangler uses for `.dev.vars`) and Bun's loader agree on, so a line kit
 * writes means the same to them:
 * - Quoted with `'`, `"` or a backtick: the value runs to the closing quote and is taken as written;
 *   a `#` inside is part of the value. There are no escapes, so a value cannot hold its own quote.
 * - Unquoted: a ` #` starts a comment, and a value that starts with `#` is empty plus a comment.
 */

const QUOTES = ["'", '"', '`'] as const

/** The value of one dotenv line, given the text after `KEY=` (already trimmed). */
export function dotenvValue(raw: string): string {
  // `KEY= # note`: the caller's trim ate the space, so the comment arrives first.
  if (raw.startsWith('#')) return ''
  const quoted = /^(['"`])(.*?)\1\s*(?:#.*)?$/.exec(raw)
  if (quoted) return quoted[2]!
  return raw.replace(/\s+#.*$/, '')
}

/**
 * Unquoted would be read back differently: any `#` (dotenv cuts at a bare `#`, kit at ` #`),
 * whitespace at either end (trimmed), or a leading quote (taken as a quoted value).
 */
const needsQuotes = (value: string) => /#|^\s|\s$|^['"`]/.test(value)

/** dotenv expands `\n` and `\r` inside double quotes only, so such a value must not go in them. */
const fits = (value: string, quote: string) =>
  !value.includes(quote) && (quote !== '"' || !/\\[nr]/.test(value))

/**
 * A value as it goes after `KEY=`: bare when that reads back intact, else in the first quote style
 * the value does not contain (`prefer` first, to keep a line's existing style). A multi-line value
 * (a PEM) is double-quoted with `\n`, which dotenv expands.
 */
export function dotenvEncode(value: string, prefer?: string): string {
  if (/[\r\n]/.test(value)) return `"${value.replace(/\r?\n/g, '\\n')}"`
  if (prefer && fits(value, prefer)) return `${prefer}${value}${prefer}`
  if (!needsQuotes(value)) return value
  const quote = QUOTES.find((q) => fits(value, q))
  if (!quote) throw new Error('holds every quote character (\', " and `), which dotenv cannot express')
  return `${quote}${value}${quote}`
}

/** `KEY=value` (no line ending), quoted when needed. A value no dotenv line can hold is exit 3. */
export function dotenvLine(key: string, value: string, prefer?: string): string {
  try {
    return `${key}=${dotenvEncode(value, prefer)}`
  } catch (err) {
    throw new KitError(
      `Cannot write ${key} to a dotenv file: its value ${(err as Error).message}`,
      'Choose a value without one of those characters',
      ExitCode.config,
    )
  }
}
