import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const BINS = ['prep', 'fake-gradlew', 'astro', 'wrangler', 'serve']
let fx: Fixture

beforeEach(() => {
  fx = fixture('bun-workers', BINS)
})
afterEach(() => fx.cleanup())

const summary = () =>
  fx
    .calls()
    .map((c) => `${c.cwd} ${c.bin} ${c.argv.join(' ')}`.trim())
    .sort()

const editConfig = (from: string, to: string) => {
  const cfg = join(fx.dir, 'kit.config.ts')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(from, to))
}

describe('dev', () => {
  test('bare: every target with a dev command runs, output prefixed by target', async () => {
    const r = await fx.kit(['dev'])
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['./apps/api wrangler dev', './apps/web astro dev'])
    expect(r.stdout).toMatch(/api +│ wrangler ok/)
    expect(r.stdout).toMatch(/web +│ astro ok/)
  })

  test('bare includes workspace.dev as its own lane', async () => {
    editConfig("prepare: 'prep',", "prepare: 'prep', dev: 'serve --all',")
    const r = await fx.kit(['dev', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.plan.map((l: { target: string }) => l.target)).toEqual(['workspace', 'api', 'web'])
    expect(doc.plan[0].commands[0]).toEqual({ cmd: ['sh', '-c', 'serve --all'], cwd: '.' })
    expect(fx.calls()).toEqual([])
  })

  test('one target runs attached; several run together with extra args', async () => {
    expect((await fx.kit(['dev', 'web'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/web astro dev'])
    expect((await fx.kit(['dev', 'api', 'web', '--', '--port', '9'])).code).toBe(0)
    expect(summary()).toEqual([
      './apps/api wrangler dev --port 9',
      './apps/web astro dev',
      './apps/web astro dev --port 9',
    ])
  })

  test('a named target without a dev command, or an unknown one, is a usage error', async () => {
    expect((await fx.kit(['dev', 'client'])).code).toBe(2)
    const r = await fx.kit(['dev', 'apu'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Did you mean "api"?')
    expect(fx.calls()).toEqual([])
  })

  test('--env reaches the targets that declare it; none declaring it is a usage error', async () => {
    expect((await fx.kit(['dev', 'api', '--env', 'staging'])).code).toBe(2)
    expect((await fx.kit(['dev', '--env', 'prod'])).code).toBe(2)
    const r = await fx.kit(['dev', '--env', 'staging', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).plan.map((l: { target: string }) => l.target)).toEqual(['api', 'web'])
  })

  test('a server that fails stops the others and exits 1', async () => {
    fx.script('astro', 'exec sleep 20')
    fx.fail('wrangler', 3, 'port in use')
    const started = Date.now()
    const r = await fx.kit(['dev'])
    expect(r.code).toBe(1)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r.stdout).toContain('port in use')
    expect(r.stdout).toContain('exited with 3')
  })

  test('--json: one document on stdout, server output on stderr', async () => {
    const r = await fx.kit(['dev', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      interrupted: false,
      targets: [
        { name: 'api', code: 0 },
        { name: 'web', code: 0 },
      ],
    })
    expect(r.stderr).toContain('wrangler ok')
  })

  test('Ctrl-C stops every server and exits 130', async () => {
    fx.script('astro', 'exec sleep 20')
    fx.script('wrangler', 'exec sleep 20')
    const proc = fx.spawn(['dev'])
    await Bun.sleep(1000)
    const started = Date.now()
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(130)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
