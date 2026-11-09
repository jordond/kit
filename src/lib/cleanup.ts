import type { Subprocess } from 'bun'

/**
 * Process-wide cleanup and interrupt handling.
 *
 * - `onCleanup(fn)` registers work that must run however kit exits (temp secrets, restoring the tty).
 * - Running children are tracked so an interrupt can reach them.
 * - First Ctrl-C: SIGINT reaches every child's process tree, kit waits for them and exits 130.
 *   With no child running it exits at once.
 * - Second Ctrl-C: SIGKILL every child, run cleanup, exit 130.
 * - SIGTERM and SIGHUP are forwarded to children (detached ones are in their own session).
 */

type Fn = () => void | Promise<void>

const cleanups: Fn[] = []
/** Running children; `group` = spawned detached as its own process group (signal the whole group). */
const children = new Map<Subprocess, { group: boolean }>()
let interrupts = 0
let installed = false

export function onCleanup(fn: Fn): () => void {
  cleanups.push(fn)
  return () => {
    const i = cleanups.indexOf(fn)
    if (i >= 0) cleanups.splice(i, 1)
  }
}

export async function runCleanup(): Promise<void> {
  while (cleanups.length) {
    const fn = cleanups.pop()!
    try {
      await fn()
    } catch {
      // cleanup must not mask the original outcome
    }
  }
}

/** True once the user pressed Ctrl-C. Commands that loop should stop. */
export const interrupted = (): boolean => interrupts > 0

export function trackChild(proc: Subprocess, group = false): void {
  children.set(proc, { group })
  void proc.exited.finally(() => children.delete(proc))
}

/**
 * Children of kit that run outside the terminal's process group (or when kit itself was signalled
 * directly, e.g. `kill -INT <pid>` in CI) need the signal forwarded.
 */
function forward(signal: NodeJS.Signals, opts: { groupsOnly?: boolean } = {}): void {
  for (const [c, { group }] of children) {
    if (opts.groupsOnly && !group) continue
    try {
      if (group) process.kill(-c.pid, signal)
      else c.kill(signal)
    } catch {
      // already gone
    }
  }
}

async function exitNow(code: number): Promise<never> {
  await runCleanup()
  process.exit(code)
}

export function installSignalHandlers(): void {
  if (installed) return
  installed = true
  process.on('SIGINT', () => {
    interrupts++
    if (interrupts > 1) {
      forward('SIGKILL')
      void exitNow(130)
      return
    }
    // A terminal Ctrl-C reaches kit's foreground group, but not detached (piped) children, which run
    // in their own group so the whole tree (sh → gradlew → java) can be signalled. Signal those always,
    // and the rest only when the signal didn't come from a terminal.
    forward('SIGINT', { groupsOnly: !!process.stdin.isTTY })
    if (children.size === 0) void exitNow(130)
  })
  // Detached children run in their own session, so a closed terminal (SIGHUP) won't reach them.
  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    process.on(signal, () => {
      interrupts++
      forward(signal)
      if (children.size === 0) void exitNow(code)
    })
  }
}

/** Test seam. */
export function resetInterrupts(): void {
  interrupts = 0
}
