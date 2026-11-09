import { Buffer } from 'node:buffer'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onCleanup, trackChild } from './cleanup'
import { childEnv, type Env } from './proc'

/**
 * Secret material for one kit run.
 *
 * - `secretFile` / `decodeSecretFile` write 0600 files under a per-run 0700 temp dir. The dir is
 *   removed by `onCleanup` (normal exit and Ctrl-C) with a sync `exit` backstop.
 * - `registerSecret` adds a value to the redaction registry; `redact(s)` replaces every registered
 *   value in `s` with `***`. Run any text that may echo values (child stderr, validation messages)
 *   through it before printing.
 * - `pipeSecret` feeds a value to a child on stdin, so it never lands in argv or shell history.
 */

export const MASK = '***'
/** Shorter values are not registered: masking every `0` or `true` would mangle output for nothing. */
const MIN_LENGTH = 4

const registry = new Set<string>()

export function registerSecret(value: string | undefined): void {
  if (!value || value.length < MIN_LENGTH) return
  registry.add(value)
  // A multi-line value (a PEM) can surface one line at a time.
  for (const line of value.split(/\r?\n/)) if (line.trim().length >= MIN_LENGTH) registry.add(line.trim())
}

export function redact(s: string): string {
  // Longest first, so a value that contains another is masked whole.
  const values = [...registry].sort((a, b) => b.length - a.length)
  let out = s
  for (const v of values) out = out.split(v).join(MASK)
  return out
}

let dir: string | undefined

function runDir(): string {
  if (dir) return dir
  const created = mkdtempSync(join(tmpdir(), 'kit-secrets-'))
  chmodSync(created, 0o700)
  dir = created
  const remove = () => {
    rmSync(created, { recursive: true, force: true })
    if (dir === created) dir = undefined
  }
  onCleanup(remove)
  process.once('exit', remove)
  return created
}

/** Write `contents` to a 0600 file in the run's temp dir and return its path. */
export function secretFile(name: string, contents: string | Uint8Array): string {
  if (name.includes('/') || name.includes('\\')) throw new Error(`secretFile: "${name}" must be a file name`)
  const path = join(runDir(), name)
  writeFileSync(path, contents, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

/** Decode base64 (`APPLE_ASC_KEY_P8_BASE64`, a keystore) into a 0600 temp file. */
export function decodeSecretFile(name: string, base64: string): string {
  const bytes = Buffer.from(base64.replace(/\s+/g, ''), 'base64')
  if (!bytes.length) throw new Error(`decodeSecretFile: ${name} decoded to nothing`)
  return secretFile(name, bytes)
}

/** The run's temp dir if one was created. Test seam. */
export const secretDir = (): string | undefined => dir

/** Remove the temp dir and forget registered values. Test seam. */
export function resetSecrets(): void {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  registry.clear()
}

export interface PipeResult {
  code: number
  /** stderr, plus stdout on failure (wrangler reports auth errors there). Redacted. */
  output: string
}

/** Run `cmd` with `input` on stdin. Output is captured and redacted, never streamed. */
export async function pipeSecret(
  cmd: readonly string[],
  input: string,
  opts: { cwd?: string; env?: Env } = {},
): Promise<PipeResult> {
  registerSecret(input)
  const proc = Bun.spawn([...cmd], {
    cwd: opts.cwd ?? '.',
    env: childEnv(opts.env),
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  trackChild(proc)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  const output = code !== 0 ? `${stderr}${stdout ? `\n${stdout}` : ''}` : stderr
  return { code, output: redact(output) }
}
