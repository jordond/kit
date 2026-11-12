import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

let fx: Fixture

const write = (path: string, content = 'x') => {
  mkdirSync(dirname(join(fx.dir, path)), { recursive: true })
  writeFileSync(join(fx.dir, path), content)
}
const has = (path: string) => existsSync(join(fx.dir, path))

const OUTPUT = [
  'apps/api/.wrangler/tmp',
  'apps/api/dist',
  'apps/client/.gradle',
  'apps/client/build',
  'apps/client/shared/build',
  'apps/web/.astro',
]
const KEPT = [
  'apps/api/src/index.ts',
  'apps/api/.wrangler/state/v3/d1/db.sqlite',
  'apps/client/shared/src/main/kotlin/build/Keep.kt',
  'node_modules/.bin',
  'kit.config.ts',
]

beforeEach(() => {
  fx = fixture('bun-workers', ['fake-gradlew'])
  write('apps/client/settings.gradle.kts')
  write('apps/client/build/out.jar', 'x'.repeat(2048))
  write('apps/client/.gradle/cache.bin')
  write('apps/client/shared/build.gradle.kts')
  write('apps/client/shared/build/A.class')
  write('apps/client/shared/src/main/kotlin/build/Keep.kt')
  write('apps/api/dist/worker.js')
  write('apps/api/.wrangler/tmp/bundle.js')
  write('apps/api/.wrangler/state/v3/d1/db.sqlite')
  write('apps/api/src/index.ts')
  write('apps/web/.astro/types.d.ts')
})
afterEach(() => fx.cleanup())

const paths = (list: { path: string }[]) => list.map((i) => i.path).sort()

describe('kit clean', () => {
  test('--dry-run lists each path with its size and deletes nothing', async () => {
    const r = await fx.kit(['clean', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    for (const p of OUTPUT) expect(r.stderr).toContain(p)
    expect(r.stderr).toMatch(/2\.0 KB {2}apps\/client\/build/)
    expect(r.stderr).toContain('Would remove 6 paths')
    for (const p of [...OUTPUT, ...KEPT]) expect(has(p)).toBe(true)

    const json = await fx.kit(['clean', '--dry-run', '--json'])
    const doc = JSON.parse(json.stdout)
    expect(doc).toMatchObject({ dryRun: true, removed: [] })
    expect(paths(doc.plan)).toEqual(OUTPUT)
    expect(doc.plan.find((i: { path: string }) => i.path === 'apps/client/build').bytes).toBe(2048)
    expect(json.stderr).toBe('')
    for (const p of OUTPUT) expect(has(p)).toBe(true)
  })

  test('without a terminal it needs --yes, and removes nothing', async () => {
    const r = await fx.kit(['clean'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Re-run with --yes')
    for (const p of OUTPUT) expect(has(p)).toBe(true)
  })

  test('--yes removes build output and nothing else', async () => {
    const r = await fx.kit(['clean', '--yes', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.ok).toBe(true)
    expect(paths(doc.removed)).toEqual(OUTPUT)
    expect(doc.bytes).toBe(doc.removed.reduce((n: number, i: { bytes: number }) => n + i.bytes, 0))
    expect(doc.bytes).toBeGreaterThanOrEqual(2048)
    for (const p of OUTPUT) expect(has(p)).toBe(false)
    for (const p of KEPT) expect(has(p)).toBe(true)
    expect(fx.calls()).toEqual([])

    const again = await fx.kit(['clean', '--yes'])
    expect(again.code).toBe(0)
    expect(again.stderr).toContain('Nothing to clean')
    expect(JSON.parse((await fx.kit(['clean', '--json'])).stdout)).toEqual({
      ok: true,
      removed: [],
      bytes: 0,
    })
  })

  test('named targets only; an unknown one is a usage error', async () => {
    const r = await fx.kit(['clean', 'api', '--yes'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('removed 2 paths')
    expect(has('apps/api/dist')).toBe(false)
    expect(has('apps/api/.wrangler/tmp')).toBe(false)
    expect(has('apps/client/build')).toBe(true)
    expect(has('apps/web/.astro')).toBe(true)
    expect((await fx.kit(['clean', 'apu', '--yes'])).code).toBe(2)
  })

  test('--deep names .wrangler/state as local data and removes node_modules too', async () => {
    write('.kit/node_modules/kit/index.js')
    const dry = await fx.kit(['clean', '--deep', '--dry-run'])
    expect(dry.stderr).toMatch(/apps\/api\/\.wrangler\/state {2}local D1\/KV data/)
    expect(dry.stderr).toContain('node_modules')

    const r = await fx.kit(['clean', '--deep', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(paths(JSON.parse(r.stdout).removed)).toEqual(
      [...OUTPUT, '.kit/node_modules', 'apps/api/.wrangler/state', 'node_modules'].sort(),
    )
    expect(has('node_modules')).toBe(false)
    expect(has('.kit/node_modules')).toBe(false)
    expect(has('apps/api/.wrangler/state')).toBe(false)
    expect(has('apps/api/src/index.ts')).toBe(true)
  })
})
