/**
 * The value of one dotenv line, given the text after `KEY=` (already trimmed).
 * Quoted: runs to the closing quote; a `#` inside the quotes is part of the value.
 * Unquoted: a ` #` starts a comment, as in dotenv and Bun's own loader.
 */
export function dotenvValue(raw: string): string {
  const quoted = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(raw)
  if (quoted) return quoted[2]!
  return raw.replace(/\s+#.*$/, '')
}
