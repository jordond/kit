import pc from 'picocolors'
import { interrupted, trackChild } from './cleanup'
import { childEnv } from './proc'
import type { PlannedCommand } from './targets'

/**
 * Run several long-lived commands at once (`kit dev` with no target): one lane per target, each
 * lane's commands in order, every line prefixed with the lane name.
 *
 * - Children get their own process group, so Ctrl-C (forwarded by `cleanup.ts`) stops every tree;
 *   kit waits for all of them and exits 130.
 * - A lane that exits non-zero on its own stops the others (SIGTERM) and the run fails.
 * - A lane that exits 0 just ends; the rest keep running.
 */

export interface Lane {
  name: string
  commands: PlannedCommand[]
}

export interface LaneResult {
  name: string
  code: number
}

const COLORS = [pc.cyan, pc.magenta, pc.green, pc.yellow, pc.blue, pc.red] as const

export async function runConcurrent(
  lanes: Lane[],
  opts: { write?: (s: string) => void } = {},
): Promise<LaneResult[]> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s))
  const width = Math.max(...lanes.map((l) => l.name.length))
  const running = new Set<Bun.Subprocess>()
  let stopping = false

  const stopOthers = () => {
    if (stopping) return
    stopping = true
    for (const p of running) {
      try {
        process.kill(-p.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
  }

  const pump = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
    const decoder = new TextDecoder()
    let carry = ''
    for await (const chunk of stream) {
      const lines = (carry + decoder.decode(chunk, { stream: true })).split(/\r?\n/)
      carry = lines.pop() ?? ''
      for (const l of lines) write(`${prefix}${l}\n`)
    }
    if (carry) write(`${prefix}${carry}\n`)
  }

  const runLane = async (lane: Lane, i: number): Promise<LaneResult> => {
    const color = COLORS[i % COLORS.length]!
    const prefix = `${color(lane.name.padEnd(width))} ${pc.dim('│')} `
    let code = 0
    for (const c of lane.commands) {
      if (stopping || interrupted()) break
      const proc = Bun.spawn([...c.cmd], {
        cwd: c.cwd,
        env: childEnv(c.env),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      })
      trackChild(proc, true)
      running.add(proc)
      await Promise.all([
        pump(proc.stdout as ReadableStream<Uint8Array>, prefix),
        pump(proc.stderr as ReadableStream<Uint8Array>, prefix),
      ])
      code = await proc.exited
      running.delete(proc)
      if (code !== 0) break
    }
    // Stopped by Ctrl-C or by another lane's failure: not this lane's failure.
    if (code !== 0 && !interrupted() && !stopping) {
      write(`${prefix}${pc.red(`exited with ${code}`)}\n`)
      stopOthers()
      return { name: lane.name, code }
    }
    return { name: lane.name, code: stopping || interrupted() ? 0 : code }
  }

  const safeLane = async (lane: Lane, i: number): Promise<LaneResult> => {
    try {
      return await runLane(lane, i)
    } catch (e) {
      // A spawn that throws (bad cwd, missing binary) must still stop the other servers.
      write(`${lane.name} ${pc.red(e instanceof Error ? e.message : String(e))}\n`)
      stopOthers()
      return { name: lane.name, code: 1 }
    }
  }
  return await Promise.all(lanes.map(safeLane))
}
