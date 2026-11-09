import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Fixture, fixture } from '../helpers/fixture'

// override/.kit/commands/test.ts replaces `kit test` and calls the built-in with a `mute` regex.
let fx: Fixture

const NOISE =
  'ld: warning: (arm64) /Users/distiller/project/kn-core/build/libkn.a(a.o) was built with -gmodules, but the module cache is missing'

beforeEach(() => {
  fx = fixture('override', ['noisy-test'])
  fx.script('noisy-test', `echo '${NOISE}'\necho 'real failure: expected 2, got 3'\nexit "\${EXIT:-0}"`)
})
afterEach(() => fx.cleanup())

test('ctx.builtin runs the replaced built-in and drops muted lines', async () => {
  const r = await fx.kit(['test'])
  expect(r.code).toBe(0)
  expect(r.stderr).toContain('wrapped')
  expect(r.stderr).toContain('real failure: expected 2, got 3')
  expect(r.stderr).not.toContain('distiller')
  expect(r.stderr).toContain('test passed')
})

test('muted lines stay out of the failure report and --json too', async () => {
  const r = await fx.kit(['test', '--json'], { env: { EXIT: '1' } })
  expect(r.code).toBe(1)
  const doc = JSON.parse(r.stdout)
  expect(doc).toMatchObject({ verb: 'test', ok: false })
  expect(doc.steps[0].output).toBe('real failure: expected 2, got 3')
})

test('help shows the override in the built-in place', async () => {
  const r = await fx.kit(['--help'])
  expect(r.stdout).toContain('linker noise muted')
})
