import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const BINS = ['prep', 'biome', 'tsc', 'fake-gradlew', 'vitest', 'vite', 'astro', 'wrangler']
let fx: Fixture

beforeEach(() => {
  fx = fixture('bun-workers', BINS)
})
afterEach(() => fx.cleanup())

const summary = (calls = fx.calls()) => calls.map((c) => `${c.cwd} ${c.bin} ${c.argv.join(' ')}`.trim())

describe('verbs', () => {
  test('check runs prepare, workspace, then targets', async () => {
    const r = await fx.kit(['check'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(summary()).toEqual([
      '. prep',
      '. biome check .',
      '. tsc --noEmit',
      './apps/web astro check',
      './apps/client fake-gradlew spotlessCheck',
    ])
  })

  test('naming a gradle target skips the workspace', async () => {
    expect((await fx.kit(['check', 'client'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/client fake-gradlew spotlessCheck'])
  })

  test('test: script defaults, gradle task list in one invocation, extra args after --', async () => {
    const r = await fx.kit(['test', 'api', 'client', '--', '--foo'])
    expect(r.code).toBe(0)
    expect(summary()).toEqual([
      '. prep',
      './apps/api vitest --foo',
      './apps/client fake-gradlew :shared:test :android:test --foo',
    ])
  })

  test('keeps going after a failure, exits 1, names the failure', async () => {
    fx.fail('biome', 1, 'lint error in a.ts')
    const r = await fx.kit(['lint'])
    expect(r.code).toBe(1)
    expect(summary()).toContain('./apps/client fake-gradlew spotlessCheck')
    expect(r.stderr).toContain('lint error in a.ts')
    expect(r.stderr).toContain('lint failed: workspace › biome check .')
  })

  test('--bail stops at the first failure', async () => {
    fx.fail('biome')
    const r = await fx.kit(['lint', '--bail'])
    expect(r.code).toBe(1)
    expect(summary()).toEqual(['. prep', '. biome check .'])
  })

  test('--json writes one document to stdout', async () => {
    fx.fail('astro', 2)
    const r = await fx.kit(['check', '--json'])
    expect(r.code).toBe(1)
    const doc = JSON.parse(r.stdout)
    expect(doc.ok).toBe(false)
    expect(doc.steps.find((s: { ok: boolean }) => !s.ok).target).toBe('web')
    expect(r.stderr).toBe('')
  })

  test('lint --fix runs format commands', async () => {
    expect((await fx.kit(['lint', '--fix', 'client'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/client fake-gradlew spotlessApply'])
  })

  test('build --release builds the configured module', async () => {
    expect((await fx.kit(['build', 'client', '--release'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/client fake-gradlew :android:bundleRelease'])
  })

  test('build --release on a non-gradle target is a usage error', async () => {
    expect((await fx.kit(['build', 'api', '--release'])).code).toBe(2)
  })

  test('unknown target: exit 2 with a suggestion', async () => {
    const r = await fx.kit(['test', 'apu'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Did you mean "api"?')
  })

  test('--dry-run runs nothing', async () => {
    const r = await fx.kit(['build', '--dry-run'])
    expect(r.code).toBe(0)
    expect(fx.calls()).toEqual([])
    expect(r.stderr).toContain('apps/client $ ./gradlew build')
  })

  test('runs from a subdirectory with --cwd', async () => {
    expect((await fx.kit(['--cwd', 'apps/client', 'test', 'client'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/client fake-gradlew :shared:test :android:test'])
  })

  test('deploy with env validates and runs the env script', async () => {
    expect((await fx.kit(['deploy', 'web', '--env', 'prod'])).code).toBe(2)
    const r = await fx.kit(['deploy', 'web', '--env', 'staging'])
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['./apps/web astro deploy staging'])
  })

  test('deploy --json: one document on stdout, child output on stderr', async () => {
    const cfg = join(fx.dir, 'kit.config.ts')
    writeFileSync(
      cfg,
      readFileSync(cfg, 'utf8').replace(
        "envs: ['staging'] }",
        "envs: ['staging'], deploy: { before: ['--version'] } }",
      ),
    )
    const r = await fx.kit(['deploy', 'web', '--env', 'staging', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      deploys: [
        {
          target: 'web',
          env: 'staging',
          ok: true,
          steps: [
            { title: 'kit --version', code: 0 },
            { title: expect.any(String), code: 0 },
          ],
        },
      ],
    })
    expect(r.stderr).toContain('astro ok')
    expect(r.stderr).toMatch(/\d+\.\d+\.\d+/)
  })

  test('deploy --json: a failed deploy is ok:false and exits 1', async () => {
    fx.fail('astro', 3, 'deploy broke')
    const r = await fx.kit(['deploy', 'web', '--env', 'staging', '--json'])
    expect(r.code).toBe(1)
    const doc = JSON.parse(r.stdout)
    expect(doc.ok).toBe(false)
    expect(doc.deploys[0].steps.at(-1).code).toBe(3)
    expect(r.stderr).toContain('deploy broke')
  })

  test('deploy several targets in order; --env goes to the ones that declare it', async () => {
    const r = await fx.kit(['deploy', 'web', 'api', '--env', 'staging'])
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['./apps/api wrangler deploy', './apps/web astro deploy staging'])
  })

  test('deploy stops at the first failed target and names the skipped ones', async () => {
    fx.fail('wrangler', 4)
    const r = await fx.kit(['deploy', 'api', 'web'])
    expect(r.code).toBe(1)
    expect(summary()).toEqual(['./apps/api wrangler deploy'])
    expect(r.stderr).toContain('deploy api failed (exit 4); skipped web')
  })

  test('deploy needs a target; --dry-run --json plans every one and runs nothing', async () => {
    expect((await fx.kit(['deploy'])).code).toBe(2)
    expect((await fx.kit(['deploy', 'api', '--env', 'staging'])).code).toBe(2)
    const r = await fx.kit(['deploy', 'api', 'web', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      dryRun: true,
      deploys: [
        { target: 'api', plan: ['bun x wrangler deploy'] },
        { target: 'web', plan: ['bun run deploy'] },
      ],
    })
    expect(fx.calls()).toEqual([])
  })

  test('outside a project: exit 3', async () => {
    const r = await fx.kit(['check'], { cwd: '..' })
    expect(r.code).toBe(3)
  })

  test('SIGINT stops the run, skips the rest, exits 130', async () => {
    fx.script('prep', 'sleep 10')
    const proc = fx.spawn(['check'])
    await Bun.sleep(800)
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(130)
    expect(await new Response(proc.stderr).text()).toContain('check interrupted')
  })
})
