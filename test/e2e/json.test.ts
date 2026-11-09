import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

// --json: stdout is exactly one JSON document (JSON.parse of all of it), whatever the children print.
let fx: Fixture
afterEach(() => fx.cleanup())

const one = (stdout: string) => {
  expect(stdout.trim()).not.toBe('')
  return JSON.parse(stdout) as Record<string, unknown>
}

describe('verbs', () => {
  const BINS = ['prep', 'biome', 'tsc', 'fake-gradlew', 'vitest', 'vite', 'astro', 'wrangler']
  const start = () => {
    fx = fixture('bun-workers', BINS)
  }

  test.each([
    [['lint'], 'lint'],
    [['lint', '--fix'], 'lint --fix'],
    [['format'], 'format'],
    [['format', '--check'], 'format --check'],
    [['typecheck'], 'typecheck'],
    [['check'], 'check'],
    [['test'], 'test'],
    [['build'], 'build'],
    [['build', 'client', '--release'], 'build'],
  ])('%p --json: one document, nothing on stderr', async (args, verb) => {
    start()
    const r = await fx.kit([...args, '--json'])
    expect(r.code).toBe(0)
    expect(one(r.stdout)).toMatchObject({ verb, ok: true })
    expect(r.stderr).toBe('')
  })

  test.each([['lint'], ['test'], ['build']])(
    '%s --dry-run --json: the plan as one document',
    async (verb) => {
      start()
      const r = await fx.kit([verb, '--dry-run', '--json'])
      expect(r.code).toBe(0)
      expect(Array.isArray(one(r.stdout).plan)).toBe(true)
      expect(fx.calls()).toEqual([])
    },
  )

  test('nothing to run is still one document', async () => {
    start()
    const r = await fx.kit(['typecheck', 'client', '--json'])
    expect(r.code).toBe(0)
    expect(one(r.stdout)).toMatchObject({ verb: 'typecheck', ok: true, steps: [] })
  })
})

describe('setup commands', () => {
  const BINS = ['fake-gradlew', 'pnpm', 'wrangler', 'open', 'java', 'ruby', 'xcodebuild']
  const start = () => {
    fx = fixture('setup-repo', BINS)
    writeFileSync(join(fx.dir, '.env'), 'API_KEY=x\nOTHER_KEY=y\n')
  }

  test('doctor --json', async () => {
    start()
    const r = await fx.kit(['doctor', '--json'], { env: { ANDROID_HOME: '/nonexistent' } })
    const doc = one(r.stdout)
    expect(Array.isArray(doc.checks)).toBe(true)
    expect(typeof doc.ok).toBe('boolean')
    expect(r.stderr).toBe('')
  })

  test('config --json', async () => {
    start()
    const r = await fx.kit(['config', '--json'])
    expect(r.code).toBe(0)
    expect(one(r.stdout)).toMatchObject({ config: { name: 'Setup' } })
  })

  test.skipIf(process.platform !== 'darwin')('xcode --json: child output stays off stdout', async () => {
    start()
    const r = await fx.kit(['xcode', '--json'])
    expect(r.code).toBe(0)
    expect(one(r.stdout)).toEqual({ project: 'apps/client/ios/iosApp.xcodeproj', opened: true })
    expect(r.stderr).toContain('open ok')
    const dry = await fx.kit(['xcode', '--json', '--dry-run'])
    expect(one(dry.stdout)).toMatchObject({ opened: false })
  })

  test('passthroughs document that they take no --json', async () => {
    start()
    for (const cmd of ['gradle', 'wrangler']) {
      expect((await fx.kit([cmd, '--help'])).stdout).toContain('no --json')
    }
  })
})
