import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const BINS = ['prep', 'biome', 'tsc', 'fake-gradlew', 'vitest', 'vite', 'astro', 'wrangler']
let fx: Fixture

const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: fx.dir, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const write = (path: string, content = 'x') => {
  mkdirSync(dirname(join(fx.dir, path)), { recursive: true })
  writeFileSync(join(fx.dir, path), content)
}

const commit = (path: string, subject: string) => {
  write(path, subject)
  git('add', path)
  git('commit', '-q', '-m', subject)
}

const summary = () => fx.calls().map((c) => `${c.cwd} ${c.bin} ${c.argv.join(' ')}`.trim())

beforeEach(() => {
  fx = fixture('bun-workers', BINS)
  // `api` also depends on shared code outside its dir.
  const cfg = join(fx.dir, 'kit.config.ts')
  writeFileSync(
    cfg,
    readFileSync(cfg, 'utf8').replace("build: 'bun run build' }", "paths: ['packages/shared/**'] }"),
  )
  // The fixture helper's own files are not part of the repo.
  write('.gitignore', '.fakebin/\n.calls.log\nnode_modules/\n')
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'kit@example.com')
  git('config', 'user.name', 'kit')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-q', '-m', 'chore: init')
  git('checkout', '-q', '-b', 'feature')
})
afterEach(() => fx.cleanup())

describe('--affected', () => {
  test('nothing changed against an explicit base: exit 0, says so, runs nothing', async () => {
    const r = await fx.kit(['check', '--affected', '--base', 'main'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('nothing affected since main')
    expect(fx.calls()).toEqual([])

    const json = await fx.kit(['check', '--affected', '--base', 'main', '--json'])
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual({
      verb: 'check',
      ok: true,
      steps: [],
      affected: [],
      base: 'main',
    })
    expect(json.stderr).toBe('')
  })

  test('HEAD is the default base and the tree is clean: runs everything, warns, gives a reason', async () => {
    git('checkout', '-q', 'main')
    const r = await fx.kit(['lint', '--affected'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(
      '--affected: HEAD is the base (main) and nothing is uncommitted; running every target',
    )
    expect(r.stderr).toContain('--base HEAD~1')
    expect(summary()).toEqual([
      '. prep',
      '. biome check .',
      './apps/web astro check',
      './apps/client fake-gradlew spotlessCheck',
    ])
    const json = await fx.kit(['lint', 'web', 'client', '--affected', '--dry-run', '--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({
      affected: ['web', 'client'],
      base: 'main',
      reason: 'head-is-base',
    })
    // An uncommitted change on the base is a real diff again.
    write('apps/web/src/a.astro')
    const dirty = await fx.kit(['lint', '--affected', '--dry-run', '--json'])
    const doc = JSON.parse(dirty.stdout)
    expect(doc).toMatchObject({ affected: ['web'], base: 'main' })
    expect(doc.reason).toBeUndefined()
  })

  test('a file moved from one target into another affects both', async () => {
    git('checkout', '-q', 'main')
    commit('apps/client/shared/util.kt', 'fun util() = "a helper long enough for rename detection"\n')
    git('checkout', '-q', '-B', 'feature')
    mkdirSync(join(fx.dir, 'apps/web/src'), { recursive: true })
    git('mv', 'apps/client/shared/util.kt', 'apps/web/src/util.kt')
    git('commit', '-q', '-m', 'refactor: move util')
    const r = await fx.kit(['lint', '--affected', '--dry-run', '--json'])
    expect(JSON.parse(r.stdout)).toMatchObject({ affected: ['web', 'client'], base: 'main' })
  })

  test('kit root below the git toplevel: a change outside it affects every target', async () => {
    // A second fixture whose git root is one level above kit.config.ts.
    const nested = fixture('bun-workers', BINS)
    try {
      const top = join(nested.dir, 'mono')
      const g = (...args: string[]) => {
        const p = Bun.spawnSync(['git', ...args], { cwd: nested.dir, stdout: 'pipe', stderr: 'pipe' })
        if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
      }
      mkdirSync(top)
      for (const f of ['kit.config.ts', 'apps', 'bun.lock']) renameSync(join(nested.dir, f), join(top, f))
      writeFileSync(join(nested.dir, '.gitignore'), '.fakebin/\n.calls.log\nnode_modules/\n')
      writeFileSync(join(nested.dir, 'root.lock'), 'v1')
      g('init', '-q', '-b', 'main')
      g('config', 'user.email', 'kit@example.com')
      g('config', 'user.name', 'kit')
      g('config', 'commit.gpgsign', 'false')
      g('add', '-A')
      g('commit', '-q', '-m', 'chore: init')
      g('checkout', '-q', '-b', 'feature')
      writeFileSync(join(nested.dir, 'root.lock'), 'v2')
      g('commit', '-q', '-am', 'chore: root lockfile')
      const r = await nested.kit(['lint', '--affected', '--dry-run', '--json'], { cwd: 'mono' })
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toMatchObject({ affected: ['api', 'web', 'client'], base: 'main' })

      mkdirSync(join(top, 'apps/web/src'), { recursive: true })
      writeFileSync(join(top, 'apps/web/src/a.astro'), 'x')
      const inside = await nested.kit(['lint', '--affected', '--base', 'HEAD', '--dry-run', '--json'], {
        cwd: 'mono',
      })
      expect(JSON.parse(inside.stdout)).toMatchObject({ affected: ['web'], base: 'HEAD' })

      // --staged: paths relative to the kit root select the target and reach the workspace tool;
      // a staged file outside the kit root is neither passed nor fans out.
      writeFileSync(join(nested.dir, 'root.lock'), 'v3')
      g('add', 'mono/apps/web/src/a.astro', 'root.lock')
      expect((await nested.kit(['lint', '--staged'], { cwd: 'mono' })).code).toBe(0)
      expect(nested.calls().map((c) => `${c.cwd} ${c.bin} ${c.argv.join(' ')}`.trim())).toEqual([
        './mono prep',
        './mono biome check . apps/web/src/a.astro',
        './mono/apps/web astro check',
      ])
    } finally {
      nested.cleanup()
    }
  })

  test('a commit on the branch under one target: the workspace and that target', async () => {
    commit('apps/web/src/a.astro', 'feat: web page')
    const r = await fx.kit(['check', '--affected'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('affected: web (base main)')
    expect(summary()).toEqual(['. prep', '. biome check .', '. tsc --noEmit', './apps/web astro check'])
  })

  test('staged, unstaged and untracked files count too', async () => {
    write('apps/web/src/untracked.astro')
    write('apps/client/gradlew', '#!/bin/sh\n# edited\nexec fake-gradlew "$@"\n')
    const r = await fx.kit(['lint', '--affected', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ verb: 'lint', ok: true, affected: ['web', 'client'], base: 'main' })
    expect(doc.steps.map((s: { target: string }) => s.target)).toEqual([
      'workspace',
      'workspace',
      'web',
      'client',
    ])
    expect(r.stderr).toBe('')
  })

  test('targets.<name>.paths: shared code outside the target dir', async () => {
    commit('packages/shared/src/x.ts', 'feat: shared')
    const r = await fx.kit(['test', '--affected'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('affected: api (base main)')
    expect(summary()).toEqual(['. prep', './apps/api vitest'])
  })

  test('a root file no target owns affects every target', async () => {
    commit('bun.lock', 'chore: lockfile')
    const r = await fx.kit(['lint', '--affected'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('affected: api, web, client (base main)')
    expect(summary()).toEqual([
      '. prep',
      '. biome check .',
      './apps/web astro check',
      './apps/client fake-gradlew spotlessCheck',
    ])
  })

  test('named targets intersect with the affected ones', async () => {
    commit('apps/web/src/a.astro', 'feat: web page')
    const none = await fx.kit(['lint', 'client', '--affected', '--json'])
    expect(none.code).toBe(0)
    expect(JSON.parse(none.stdout)).toEqual({ verb: 'lint', ok: true, steps: [], affected: [], base: 'main' })
    expect(fx.calls()).toEqual([])

    commit('apps/client/shared/A.kt', 'feat: client')
    expect((await fx.kit(['lint', 'client', '--affected'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/client fake-gradlew spotlessCheck'])
  })

  test('--base picks the ref; the default follows origin/HEAD', async () => {
    commit('apps/web/src/a.astro', 'feat: web page')
    commit('apps/client/shared/A.kt', 'feat: client')
    const r = await fx.kit(['lint', '--affected', '--base', 'HEAD~1', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ affected: ['client'], base: 'HEAD~1' })

    git('update-ref', 'refs/remotes/origin/trunk', 'HEAD~1')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    const d = await fx.kit(['lint', '--affected', '--dry-run', '--json'])
    expect(JSON.parse(d.stdout)).toMatchObject({ affected: ['client'], base: 'origin/trunk' })
    expect(fx.calls()).toEqual([])
  })

  test('base not found: warns and runs everything', async () => {
    const r = await fx.kit(['lint', '--affected', '--base', 'origin/nope'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('--affected: base "origin/nope" not found; running every target')
    expect(summary()).toEqual([
      '. prep',
      '. biome check .',
      './apps/web astro check',
      './apps/client fake-gradlew spotlessCheck',
    ])
    const json = await fx.kit(['lint', '--affected', '--base', 'origin/nope', '--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      affected: ['api', 'web', 'client'],
      base: null,
    })
  })

  test('usage errors: with --staged, and --base alone', async () => {
    const both = await fx.kit(['lint', '--affected', '--staged'])
    expect(both.code).toBe(2)
    expect(both.stderr).toContain('--affected and --staged')
    expect((await fx.kit(['test', '--base', 'main'])).code).toBe(2)
    expect((await fx.kit(['test', 'apu', '--affected'])).code).toBe(2)
    expect(fx.calls()).toEqual([])
  })

  test('--staged honours paths too, and a staged root file does not fan out', async () => {
    const cfg = join(fx.dir, 'kit.config.ts')
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace("envs: ['staging'] }", "paths: ['packages/ui'] }"))
    write('packages/ui/Button.tsx')
    git('add', 'packages/ui/Button.tsx')
    expect((await fx.kit(['lint', '--staged'])).code).toBe(0)
    // web is selected through its paths; only the workspace command gets the staged file.
    expect(summary()).toEqual(['. prep', '. biome check . packages/ui/Button.tsx', './apps/web astro check'])

    git('reset', '-q')
    write('bun.lock', 'changed')
    git('add', 'bun.lock')
    expect((await fx.kit(['lint', '--staged'])).code).toBe(0)
    expect(summary().slice(3)).toEqual(['. prep', '. biome check . bun.lock'])
  })

  test.each(['lint', 'format', 'typecheck', 'check', 'test', 'build'])(
    '%s takes --affected',
    async (verb) => {
      commit('apps/api/src/a.ts', 'feat: api')
      const r = await fx.kit([verb, '--affected', '--dry-run', '--json'])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toMatchObject({ affected: ['api'], base: 'main' })
    },
  )
})

describe('step timings', () => {
  test('--json: ms per step and a total', async () => {
    const r = await fx.kit(['check', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.steps).toHaveLength(5)
    for (const s of doc.steps) expect(Number.isInteger(s.ms)).toBe(true)
    expect(Number.isInteger(doc.ms)).toBe(true)
    expect(doc.ms).toBeGreaterThanOrEqual(Math.max(...doc.steps.map((s: { ms: number }) => s.ms)))
  })

  test('summary lists the slowest steps first; one step gets no list', async () => {
    fx.script('tsc', 'sleep 1')
    const r = await fx.kit(['check'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('✔ check passed (5 steps, ')
    const timings = r.stderr.split('\n').filter((l) => /^ {2}\d+\.\ds {2}\S/.test(l))
    expect(timings).toHaveLength(5)
    expect(timings[0]).toMatch(/^ {2}\d+\.\ds {2}workspace › tsc --noEmit$/)

    const one = await fx.kit(['check', 'client'])
    expect(one.stderr).toContain('✔ check passed (1 steps, ')
    expect(one.stderr.split('\n').filter((l) => /^ {2}\d+\.\ds {2}\S/.test(l))).toEqual([])
  })

  test('top five by default, every step with --verbose, none with --quiet', async () => {
    // Six steps: prepare, two workspace verbs, astro check, and two gradle tasks run separately.
    const cfg = join(fx.dir, 'kit.config.ts')
    writeFileSync(
      cfg,
      readFileSync(cfg, 'utf8').replace(
        "test: [':shared:test', ':android:test'] }",
        "lint: ['spotlessCheck', 'echo detekt'] }",
      ),
    )
    const lines = (stderr: string) => stderr.split('\n').filter((l) => /^ {2}\d+\.\ds {2}\S/.test(l))
    const r = await fx.kit(['check'])
    expect(r.stderr).toContain('✔ check passed (6 steps, ')
    expect(lines(r.stderr)).toHaveLength(5)
    expect(r.stderr).toContain('… 1 more (--verbose lists every step)')
    expect(lines((await fx.kit(['check', '--verbose'])).stderr)).toHaveLength(6)
    expect(lines((await fx.kit(['check', '--quiet'])).stderr)).toEqual([])
  })

  test('a failed run lists timings after the failure line', async () => {
    fx.fail('biome', 1, 'lint error')
    const r = await fx.kit(['lint'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('lint failed: workspace › biome check .')
    expect(r.stderr).toMatch(/\d+\.\ds {2}workspace › biome check \./)
  })

  test('deploy --json: ms per step, per target and in total', async () => {
    const r = await fx.kit(['deploy', 'api', 'web', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(Number.isInteger(doc.ms)).toBe(true)
    for (const d of doc.deploys) {
      expect(Number.isInteger(d.ms)).toBe(true)
      for (const s of d.steps) expect(Number.isInteger(s.ms)).toBe(true)
    }
  })
})
