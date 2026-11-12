import { describe, expect, test } from 'bun:test'
import { exitOf } from '../../src/lib/proc'

describe('exitOf', () => {
  test('a running child has not ended', async () => {
    const proc = Bun.spawn(['sleep', '5'], { stdin: 'ignore' })
    expect(exitOf(proc)).toBeUndefined()
    proc.kill()
    await proc.exited
  })

  test('an exit code is reported', async () => {
    const proc = Bun.spawn(['sh', '-c', 'exit 3'], { stdin: 'ignore' })
    await proc.exited
    expect(exitOf(proc)).toBe('code 3')
  })

  test('a child killed by a signal has ended, though it has no exit code', async () => {
    const proc = Bun.spawn(['sh', '-c', 'kill -SEGV $$'], { stdin: 'ignore' })
    await proc.exited
    expect(proc.exitCode).toBeNull()
    expect(exitOf(proc)).toBe('signal SIGSEGV')
  })
})
