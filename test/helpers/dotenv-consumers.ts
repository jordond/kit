import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The programs other than kit that read the dotenv files kit writes, for differential tests:
 * - `dotenvParse`: dotenv `parse`, which wrangler uses for `.dev.vars` (no expansion).
 * - `dotenvExpand`: dotenv-expand on top of it, wrangler's `.env` fallback.
 * - `bunEnvFile`: a real `bun --env-file` child, which is how `.env` reaches kit itself.
 * The first two are vendored so the tests need no dependency.
 */

// Vendored from dotenv 16.3.1, lib/main.js `parse` (https://github.com/motdotla/dotenv),
// Copyright (c) 2015, Scott Motte, BSD-2-Clause. Logic unchanged; only typed.
const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm

export function dotenvParse(src: string): Record<string, string> {
  const obj: Record<string, string> = {}
  const lines = src.toString().replace(/\r\n?/gm, '\n')
  LINE.lastIndex = 0
  let match = LINE.exec(lines)
  while (match != null) {
    const key = match[1]!
    let value = (match[2] || '').trim()
    const maybeQuote = value[0]
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2')
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, '\n')
      value = value.replace(/\\r/g, '\r')
    }
    obj[key] = value
    match = LINE.exec(lines)
  }
  return obj
}

// Adapted from dotenv-expand 12.0.2, lib/main.js `expandValue` / `expand`
// (https://github.com/motdotla/dotenv-expand), Copyright (c) 2016, Scott Motte, BSD-2-Clause.
function expandValue(value: string, env: Record<string, string>, running: Record<string, string>): string {
  const all = { ...running, ...env }
  const regex = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g
  let result = value
  const seen = new Set<string>()
  let match = regex.exec(result)
  while (match !== null) {
    seen.add(result)
    const [template, braced, unbraced] = match
    const expression = (braced || unbraced)!
    const splitter = expression.match(/(:\+|\+|:-|-)/)?.[0]
    const parts = splitter ? expression.split(splitter) : [expression]
    const key = parts.shift()!
    let fallback: string
    let found: string | undefined
    if (splitter === ':+' || splitter === '+') {
      fallback = all[key] ? parts.join(splitter) : ''
    } else {
      fallback = parts.join(splitter ?? '')
      found = all[key]
    }
    result = result.replace(template!, found && !seen.has(found) ? found : fallback)
    if (result === running[key]) break
    regex.lastIndex = 0
    match = regex.exec(result)
  }
  return result
}

export function dotenvExpand(
  parsed: Record<string, string>,
  env: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key in parsed) {
    out[key] = expandValue(parsed[key]!, env, out).replace(/\\\$/g, '$')
  }
  return out
}

/** What `bun --env-file=<file>` puts in process.env for `keys`, read by a real child process. */
export async function bunEnvFile(text: string, keys: string[]): Promise<Record<string, string | null>> {
  const dir = mkdtempSync(join(tmpdir(), 'kit-dotenv-'))
  try {
    const file = join(dir, 'under-test.env')
    writeFileSync(file, text)
    writeFileSync(join(dir, 'keys.json'), JSON.stringify(keys))
    const script =
      'const keys = JSON.parse(require("node:fs").readFileSync("keys.json", "utf8"));' +
      'process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))))'
    const proc = Bun.spawn([process.execPath, `--env-file=${file}`, '-e', script], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', HOME: '/home/kit-test' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if ((await proc.exited) !== 0) throw new Error(`bun --env-file failed: ${stderr}`)
    return JSON.parse(stdout) as Record<string, string | null>
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
