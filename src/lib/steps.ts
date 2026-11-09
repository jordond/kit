import { Writable } from 'node:stream'
import { Listr, ListrLogger, type ListrTask, ProcessOutput } from 'listr2'
import type { Flags } from '../cli/command'

export interface Step {
  title: string
  task: (update: (line: string) => void) => Promise<void> | void
}

export interface StepResult {
  title: string
  ok: boolean
  ms: number
  error?: string
}

/** Run steps as a listr2 tree on stderr. Keeps going after failures unless `bail`. */
export async function runSteps(
  steps: Step[],
  flags: Flags,
  opts: { bail?: boolean } = {},
): Promise<StepResult[]> {
  const results: StepResult[] = []
  const stream = colorEnabled() ? process.stderr : plainStderr()
  const stderrOut = new ProcessOutput(stream, stream)
  const logger = new ListrLogger({ processOutput: stderrOut, useIcons: true })
  const tty = !!process.stderr.isTTY && !flags.ci
  const tasks: ListrTask[] = steps.map((s) => ({
    title: s.title,
    task: async (_ctx, task) => {
      const start = performance.now()
      try {
        await s.task((line) => {
          task.output = line
        })
        results.push({ title: s.title, ok: true, ms: performance.now() - start })
      } catch (e) {
        results.push({ title: s.title, ok: false, ms: performance.now() - start, error: String(e) })
        throw e
      }
    },
  }))
  const list = new Listr(tasks, {
    concurrent: false,
    exitOnError: opts.bail ?? false,
    renderer: 'default',
    rendererOptions: { logger, collapseSubtasks: true },
    fallbackRenderer: 'simple',
    fallbackRendererOptions: { logger },
    fallbackRendererCondition: !tty,
    // listr2 checks stdout for TTY; kit renders on stderr, so decide from stderr.
    forceTTY: tty,
    silentRendererCondition: flags.json || flags.quiet,
  })
  try {
    await list.run()
  } catch {
    // collected in results
  }
  return results
}

const colorEnabled = () => !process.env.NO_COLOR || !!process.env.FORCE_COLOR

/**
 * stderr without ANSI colour. Bun's util.styleText (used by listr2) ignores NO_COLOR and
 * non-TTY streams, unlike Node, so colour is stripped here instead.
 */
function plainStderr(): NodeJS.WriteStream {
  const w = new Writable({
    write(chunk, _enc, cb) {
      process.stderr.write(Bun.stripANSI(String(chunk)), cb)
    },
  })
  return Object.assign(w, {
    isTTY: false,
    columns: process.stderr.columns ?? 80,
  }) as unknown as NodeJS.WriteStream
}
