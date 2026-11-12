import { Writable } from 'node:stream'
import { Listr, ListrLogger, type ListrTask, ProcessOutput } from 'listr2'
import pc from 'picocolors'
import type { Flags } from '../cli/command'
import { interrupted } from './cleanup'
import { ProcError, type RunOptions, runLines } from './proc'
import { redact } from './secrets'

/**
 * Steps render as a listr2 tree on stderr (brewd `runSteps`, ported). Every step runs even after
 * a failure, so one pass surfaces every problem; `bail` stops at the first.
 *
 * Output modes:
 * - TTY: the running step shows a rolling tail; a failed step's full output prints after the tree.
 * - not a TTY (CI) or --verbose: child output streams as it comes.
 * - --quiet: only failures' output and the summary. --json: nothing on stderr.
 */

export interface Step {
  title: string
  task: (update: (line: string) => void) => Promise<void> | void
}

export interface StepGroup {
  title: string
  steps: Step[]
}

export interface StepResult {
  group?: string
  title: string
  ok: boolean
  ms: number
  error?: string
  output?: string
}

export type StepFlags = Pick<Flags, 'json' | 'quiet' | 'verbose' | 'ci'>

/** A step that runs one command. Its output feeds the tree and, on failure, the report. */
export function commandStep(
  title: string,
  cmd: readonly string[],
  opts: RunOptions & { mute?: RegExp } = {},
): Step {
  return {
    title,
    task: async (update) => {
      const { code, output } = await runLines(cmd, { ...opts, onLine: update })
      if (code !== 0) throw new ProcError(cmd, code, output)
    },
  }
}

const isGroup = (s: Step | StepGroup): s is StepGroup => 'steps' in s

/** Run steps (or groups of steps). Never throws for a failed step; read the results. */
export async function runSteps(
  items: (Step | StepGroup)[],
  flags: StepFlags,
  opts: { bail?: boolean } = {},
): Promise<StepResult[]> {
  const results: StepResult[] = []
  const stream = colorEnabled() ? process.stderr : plainStderr()
  const out = new ProcessOutput(stream, stream)
  const logger = new ListrLogger({ processOutput: out, useIcons: true })
  const tty = !!process.stderr.isTTY && !flags.ci && !flags.verbose
  const streaming = !tty && !flags.quiet && !flags.json
  let failed = false

  const toTask = (s: Step, group?: string): ListrTask => ({
    title: group ? `${pc.dim(`${group} ›`)} ${s.title}` : s.title,
    skip: () => (opts.bail && failed) || interrupted(),
    task: async (_ctx, task) => {
      const start = performance.now()
      const update = (raw: string) => {
        const line = redact(raw)
        if (streaming) stream.write(`${pc.dim('│')} ${line}\n`)
        else task.output = line
      }
      try {
        await s.task(update)
        results.push({ group, title: s.title, ok: true, ms: performance.now() - start })
      } catch (e) {
        failed = true
        results.push({
          group,
          title: s.title,
          ok: false,
          ms: performance.now() - start,
          error: redact(e instanceof Error ? e.message : String(e)),
          output: e instanceof ProcError && e.output ? redact(e.output) : undefined,
        })
        throw e
      }
    },
  })

  // Flat list with `group › step` titles: nested listr2 lists can't report a failed child to the parent
  // when exitOnError is off.
  const tasks: ListrTask[] = items.flatMap((item) =>
    isGroup(item) ? item.steps.map((s) => toTask(s, item.title)) : [toTask(item)],
  )

  const list = new Listr(tasks, {
    concurrent: false,
    exitOnError: opts.bail ?? false,
    renderer: 'default',
    rendererOptions: { logger, collapseSubtasks: false, collapseErrors: true, showErrorMessage: false },
    fallbackRenderer: 'simple',
    fallbackRendererOptions: { logger },
    fallbackRendererCondition: !tty,
    // listr2 checks stdout for TTY; kit renders on stderr, so decide from stderr.
    forceTTY: tty,
    silentRendererCondition: flags.json || flags.quiet,
    // listr2 would exit 127 on SIGINT; kit handles interrupts (cleanup.ts) and exits 130.
    registerSignalListeners: false,
  })
  try {
    await list.run()
  } catch {
    // collected in results
  }

  // Full output of failures, unless it already streamed.
  if (!flags.json && (!streaming || flags.quiet)) {
    for (const r of results.filter((x) => !x.ok && x.output?.trim())) {
      process.stderr.write(`\n${pc.red(pc.bold(`── ${label(r)} ──`))}\n${r.output}\n`)
    }
  }
  return results
}

const label = (r: StepResult) => (r.group ? `${r.group} › ${r.title}` : r.title)

/** One-line outcome on stderr. Returns the exit code (0, 1, or 130 when interrupted). */
export function summarize(verb: string, results: StepResult[], startedAt: number, hint?: string): number {
  const secs = ((performance.now() - startedAt) / 1000).toFixed(1)
  const failed = results.filter((r) => !r.ok)
  if (interrupted()) {
    process.stderr.write(`${pc.yellow('▲')} ${verb} interrupted\n`)
    return 130
  }
  if (failed.length) {
    process.stderr.write(
      `\n${pc.red('✖')} ${verb} failed: ${failed.map(label).join(', ')} ${pc.dim(`(${secs}s)`)}\n`,
    )
    if (hint) process.stderr.write(`  ${pc.dim('›')} ${hint}\n`)
    return 1
  }
  process.stderr.write(`\n${pc.green('✔')} ${verb} passed ${pc.dim(`(${results.length} steps, ${secs}s)`)}\n`)
  return 0
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** Per-step timings for a `--json` document: `ms` in whole milliseconds. */
export const stepTimings = (results: StepResult[]): { title: string; ok: boolean; ms: number }[] =>
  results.map((r) => ({ title: r.title, ok: r.ok, ms: Math.round(r.ms) }))

/** Per-step durations, slowest first: the top `limit`, then how many were left out. */
export function timingLines(results: StepResult[], limit = 5): string[] {
  const sorted = [...results].sort((a, b) => b.ms - a.ms)
  const shown = sorted.slice(0, limit)
  const width = Math.max(0, ...shown.map((r) => seconds(r.ms).length))
  const lines = shown.map((r) => `${seconds(r.ms).padStart(width)}  ${label(r)}`)
  const more = sorted.length - shown.length
  if (more > 0) lines.push(`… ${more} more (--verbose lists every step)`)
  return lines
}

/** Step durations under the summary line, on stderr. Nothing for a single step: the summary has its time. */
export function printTimings(results: StepResult[], flags: Pick<Flags, 'verbose' | 'quiet'>): void {
  if (results.length < 2 || flags.quiet) return
  const lines = timingLines(results, flags.verbose ? results.length : 5)
  process.stderr.write(`${lines.map((l) => `  ${pc.dim(l)}`).join('\n')}\n`)
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
