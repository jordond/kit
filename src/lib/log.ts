import pc from 'picocolors'

/** All human output goes to stderr; stdout is reserved for results (`--json`). */
const write = (s: string) => process.stderr.write(`${s}\n`)

export const log = {
  info: (msg: string) => write(msg),
  step: (msg: string) => write(`${pc.cyan('›')} ${msg}`),
  success: (msg: string) => write(`${pc.green('✔')} ${msg}`),
  warn: (msg: string) => write(`${pc.yellow('▲')} ${msg}`),
  error: (msg: string, hint?: string) => {
    write(`${pc.red('✖')} ${msg}`)
    if (hint) write(`  ${pc.dim('›')} ${hint}`)
  },
  dim: (msg: string) => write(pc.dim(msg)),
}

export type Logger = typeof log

/** Write exactly one JSON document to stdout. */
let emitted = false

/** Whether a JSON document was already written this run. */
export const jsonEmitted = (): boolean => emitted

export function emitJson(value: unknown): void {
  emitted = true
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Run `fn` with stdout pointed at stderr: repo code (preflight modules) may `console.log`, and under
 * --json stdout must hold only the one document.
 */
export async function withStdoutOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  // oxlint-disable-next-line typescript/unbound-method -- saved only to be put back, never called detached
  const saved = { log: console.log, info: console.info, debug: console.debug, write: process.stdout.write }
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a)
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  try {
    return await fn()
  } finally {
    console.log = saved.log
    console.info = saved.info
    console.debug = saved.debug
    process.stdout.write = saved.write
  }
}
