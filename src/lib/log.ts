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
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
