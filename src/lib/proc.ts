import { onCleanup, trackChild } from './cleanup'

/**
 * The one spawn wrapper (ported from brewd `lib/proc.ts`).
 *
 * Children always get an explicit env: `process.env` (which already holds the root `.env`) plus
 * anything registered with `addChildEnv`, e.g. the pinned CLOUDFLARE_ACCOUNT_ID. Bun.spawn would
 * otherwise snapshot the env kit started with.
 */

export type Env = Readonly<Record<string, string | undefined>>

export interface RunOptions {
  cwd?: string
  env?: Env
}

const extraEnv: Record<string, string | undefined> = {}

/** Add variables every later child gets. */
export function addChildEnv(vars: Env): void {
  Object.assign(extraEnv, vars)
}

export function childEnv(env: Env = {}): Record<string, string | undefined> {
  return { ...process.env, ...extraEnv, ...env }
}

function spawn(
  cmd: readonly string[],
  opts: RunOptions,
  stdio: { stdin: 'inherit' | 'ignore' | Blob; stdout: 'inherit' | 'pipe'; stderr: 'inherit' | 'pipe' },
) {
  if (!cmd.length) throw new Error('proc: empty command')
  // Children that don't touch the terminal get their own process group, so an interrupt reaches the
  // whole tree (sh -c → gradlew → java) and no grandchild keeps a pipe open after kit gives up.
  const detached = stdio.stdin !== 'inherit' && stdio.stdout === 'pipe'
  const proc = Bun.spawn([...cmd], { cwd: opts.cwd ?? '.', env: childEnv(opts.env), ...stdio, detached })
  trackChild(proc, detached)
  return proc
}

/** Inherit all stdio, as if run directly. For passthroughs (`kit gradle …`). */
export async function run(cmd: readonly string[], opts: RunOptions = {}): Promise<number> {
  return await spawn(cmd, opts, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited
}

/** Like `run`, but throws on a non-zero exit. */
export async function runOrThrow(cmd: readonly string[], opts: RunOptions = {}): Promise<void> {
  const code = await run(cmd, opts)
  if (code !== 0) throw new ProcError(cmd, code)
}

/** Capture stdout and stderr into one string; print nothing. For steps whose output is noise until they fail. */
export async function runQuiet(
  cmd: readonly string[],
  opts: RunOptions = {},
): Promise<{ code: number; output: string }> {
  const proc = spawn(cmd, opts, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, output: `${stdout}${stderr}` }
}

/** Capture stdout and stderr separately; optional `input` goes to stdin (e.g. a secret value). */
export async function runPiped(
  cmd: readonly string[],
  opts: RunOptions & { input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = opts.input === undefined ? 'ignore' : new Blob([opts.input])
  const proc = spawn(cmd, opts, { stdin, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, stdout, stderr }
}

/** Capture stdout for post-processing; stderr passes through. */
export async function runCapture(
  cmd: readonly string[],
  opts: RunOptions & { stdin?: 'inherit' | 'ignore' } = {},
): Promise<{ code: number; stdout: string }> {
  const proc = spawn(cmd, opts, { stdin: opts.stdin ?? 'ignore', stdout: 'pipe', stderr: 'inherit' })
  const stdout = await new Response(proc.stdout).text()
  return { code: await proc.exited, stdout }
}

/**
 * Stream stdout and stderr line by line to `onLine`, and keep the whole output.
 * Used by steps: the tree shows the tail, failures print everything.
 */
export async function runLines(
  cmd: readonly string[],
  opts: RunOptions & { onLine?: (line: string) => void; mute?: RegExp } = {},
): Promise<{ code: number; output: string }> {
  const proc = spawn(cmd, opts, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const out: string[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    let carry = ''
    const emit = (line: string) => {
      if (opts.mute?.test(line)) return
      out.push(line)
      opts.onLine?.(line)
    }
    for await (const chunk of stream) {
      const lines = (carry + decoder.decode(chunk, { stream: true })).split(/\r?\n/)
      carry = lines.pop() ?? ''
      for (const l of lines) emit(l)
    }
    if (carry) emit(carry)
  }
  await Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array>),
    pump(proc.stderr as ReadableStream<Uint8Array>),
  ])
  return { code: await proc.exited, output: out.join('\n') }
}

/**
 * For dev servers the user stops with Ctrl-C. The terminal already signalled the child; a Ctrl-C
 * here is the user asking to stop, not a failure, so it returns 0. Restores the tty after.
 */
export async function runInteractive(cmd: readonly string[], opts: RunOptions = {}): Promise<number> {
  const proc = spawn(cmd, opts, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  let stopped = false
  const onInt = () => {
    stopped = true
  }
  process.on('SIGINT', onInt)
  const off = onCleanup(restoreTty)
  try {
    const code = await proc.exited
    return stopped ? 0 : code
  } finally {
    process.off('SIGINT', onInt)
    off()
    restoreTty()
  }
}

/**
 * A child killed mid-flight can leave the terminal in raw mode with the cursor hidden and kitty
 * key encoding pushed; the next prompt then echoes escape replies.
 */
export function restoreTty(): void {
  if (!process.stdin.isTTY) return
  Bun.spawnSync(['stty', 'sane'], { stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' })
  if (process.stderr.isTTY) process.stderr.write('\x1b[<u\x1b[?25h')
}

export class ProcError extends Error {
  constructor(
    readonly cmd: readonly string[],
    readonly code: number,
    readonly output?: string,
  ) {
    super(`${cmd.join(' ')} exited with ${code}`)
    this.name = 'ProcError'
  }
}

/** `sh -c` for a config command string, with extra args passed as "$@". */
export function shell(command: string, extra: readonly string[] = []): string[] {
  return extra.length ? ['sh', '-c', `${command} "$@"`, 'sh', ...extra] : ['sh', '-c', command]
}
