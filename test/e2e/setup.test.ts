import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

// setup-repo has a pnpm lockfile, so install and `pnpm exec wrangler` go through recording fakes.
const BINS = ['fake-gradlew', 'pnpm', 'wrangler', 'open', 'java', 'ruby', 'xcodebuild']
let fx: Fixture

beforeEach(() => {
  fx = fixture('setup-repo', BINS)
})
afterEach(() => fx.cleanup())

const summary = () => fx.calls().map((c) => `${c.cwd} ${c.bin} ${c.argv.join(' ')}`.trim())

describe('passthroughs', () => {
  test('gradle: every argument reaches ./gradlew untouched, in the Gradle root', async () => {
    const r = await fx.kit(['gradle', 'assembleDebug', '--help', '-v', '--json', '--', '-x'])
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['./apps/client fake-gradlew assembleDebug --help -v --json -- -x'])
  })

  test("gradle: exits with the child's code", async () => {
    fx.fail('fake-gradlew', 3)
    expect((await fx.kit(['gradle', 'build'])).code).toBe(3)
  })

  test('wrangler: runs through the target package manager in the target dir', async () => {
    const r = await fx.kit(['wrangler', 'api', 'd1', 'list', '--json'])
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['./apps/api pnpm exec wrangler d1 list --json'])
  })

  test('wrangler: needs a worker target', async () => {
    expect((await fx.kit(['wrangler'])).code).toBe(2)
    const r = await fx.kit(['wrangler', 'client', 'whoami'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Worker targets: api')
    expect(fx.calls()).toEqual([])
  })

  test.skipIf(process.platform !== 'darwin')(
    'xcode: opens the project found under <gradle root>/ios',
    async () => {
      const r = await fx.kit(['xcode'])
      expect(r.code).toBe(0)
      expect(summary()).toEqual(['. open -a Xcode apps/client/ios/iosApp.xcodeproj'])
    },
  )

  test('outside a project: exit 3', async () => {
    expect((await fx.kit(['gradle', 'build'], { cwd: '..' })).code).toBe(3)
  })
})

describe('doctor', () => {
  const env = () => ({ ANDROID_HOME: fx.dir, ANDROID_SDK_ROOT: '' })
  beforeEach(() => {
    fx.script('java', `echo 'openjdk version "21.0.2" 2024-01-16' >&2`)
    fx.script('ruby', `echo 'ruby 3.3.6 (2024-11-05) [arm64-darwin24]'`)
    fx.script('xcodebuild', `printf 'Xcode 26.1\\nBuild version 17B55\\n'`)
  })

  test('a missing .env is a failed precondition (exit 4); --json is one document', async () => {
    const r = await fx.kit(['doctor', '--json'], { env: env() })
    expect(r.code).toBe(4)
    const doc = JSON.parse(r.stdout)
    expect(doc.ok).toBe(false)
    const byId = Object.fromEntries(doc.checks.map((c: { id: string; status: string }) => [c.id, c.status]))
    expect(byId).toMatchObject({ bun: 'ok', java: 'ok', ruby: 'ok', 'android-sdk': 'ok', env: 'fail' })
    expect(byId.wrangler).toBe('ok')
    expect(r.stderr).toBe('')
  })

  test('all required checks pass: exit 0, lines on stderr', async () => {
    writeFileSync(join(fx.dir, '.env'), 'API_KEY=x\n')
    const r = await fx.kit(['doctor'], { env: env() })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('✔ java')
    expect(r.stderr).toContain('▲ .env')
    expect(r.stderr).toContain('missing OTHER_KEY')
  })

  test('java older than 21 fails a Gradle project', async () => {
    writeFileSync(join(fx.dir, '.env'), 'API_KEY=x\nOTHER_KEY=y\n')
    fx.script('java', `echo 'openjdk version "17.0.9"' >&2`)
    const r = await fx.kit(['doctor'], { env: env() })
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('✖ java')
    expect(r.stderr).toContain('17.0.9 (need 21+)')
  })

  test('works outside a project', async () => {
    const r = await fx.kit(['doctor', '--json'], { cwd: '..' })
    expect(JSON.parse(r.stdout).checks.length).toBeGreaterThan(0)
  })
})

describe('init', () => {
  test('--dry-run --json prints the plan and changes nothing', async () => {
    const r = await fx.kit(['init', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    const plan = JSON.parse(r.stdout).plan as { kind: string; title: string; cmd?: string[]; cwd?: string }[]
    expect(plan.map((a) => `${a.kind} ${a.title}`)).toEqual([
      'env-file .env from .env.example',
      'cmd pnpm install',
      'skip mise.toml',
      'skip lefthook.yml',
      'cmd wrangler types (api)',
    ])
    expect(plan[4]).toMatchObject({ cmd: ['pnpm', 'exec', 'wrangler', 'types'], cwd: 'apps/api' })
    expect(fx.calls()).toEqual([])
    expect(existsSync(join(fx.dir, '.env'))).toBe(false)
  })

  test('creates .env, installs, runs wrangler types; no scaffolds without a terminal', async () => {
    const r = await fx.kit(['init'])
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['. pnpm install', './apps/api pnpm exec wrangler types'])
    expect(readFileSync(join(fx.dir, '.env'), 'utf8')).toBe(
      readFileSync(join(fx.dir, '.env.example'), 'utf8'),
    )
    expect(existsSync(join(fx.dir, 'mise.toml'))).toBe(false)
    expect(r.stderr).toContain('re-run with --yes')
  })

  test('is idempotent: an existing .env is kept', async () => {
    writeFileSync(join(fx.dir, '.env'), 'API_KEY=mine\n')
    expect((await fx.kit(['init'])).code).toBe(0)
    expect(readFileSync(join(fx.dir, '.env'), 'utf8')).toBe('API_KEY=mine\n')
  })

  test('--yes writes mise.toml and lefthook.yml from templates, once', async () => {
    expect((await fx.kit(['init', '--yes'])).code).toBe(0)
    expect(readFileSync(join(fx.dir, 'mise.toml'), 'utf8')).toContain(`bun = "${Bun.version}"`)
    expect(readFileSync(join(fx.dir, 'lefthook.yml'), 'utf8')).toContain('kit lint --staged --fix')
    writeFileSync(join(fx.dir, 'mise.toml'), '[tools]\n')
    const r = await fx.kit(['init', '--yes'])
    expect(r.stderr).toContain('mise.toml exists')
    expect(readFileSync(join(fx.dir, 'mise.toml'), 'utf8')).toBe('[tools]\n')
  })

  test('a failed step keeps going and exits 1', async () => {
    fx.fail('pnpm')
    const r = await fx.kit(['init'])
    expect(r.code).toBe(1)
    expect(summary()).toHaveLength(2)
    expect(r.stderr).toContain('init failed: pnpm install, wrangler types (api)')
  })

  test('runs outside a project', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'kit-empty-'))
    try {
      mkdirSync(join(empty, 'x'))
      const r = await fx.kit(['--cwd', empty, 'init'])
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('no package.json')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('deps and help', () => {
  test('deps needs a bun workspace; usage errors exit 2', async () => {
    expect((await fx.kit(['deps'])).code).toBe(2)
    const bun = fixture('bun-workers', [])
    try {
      for (const args of [
        ['deps', 'update', 'hono'],
        ['deps', 'latest'],
        ['deps', 'bogus'],
      ]) {
        const r = await bun.kit(args)
        expect(r.code).toBe(2)
      }
      const r = await bun.kit(['deps', '--dry-run'])
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('bun outdated --filter *')
    } finally {
      bun.cleanup()
    }
  })

  /**
   * bun-workers with a root manifest and a fake `bun` first on PATH: outdated/update/install are
   * scripted (each prints to stdout), anything else (kit itself) goes to the real bun.
   */
  function bunWorkspace(update = 'echo "bun update out"') {
    const bun = fixture('bun-workers', [])
    const manifest = { name: 'ws', workspaces: [], dependencies: { 'left-pad': '^1.0.0' } }
    writeFileSync(join(bun.dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    bun.script(
      'bun',
      `case "$1" in
  outdated) printf '| Package | Current | Update | Latest |\\n|---|---|---|---|\\n| left-pad | 1.0.0 | 1.3.0 | 1.3.0 |\\n' ;;
  update) ${update} ;;
  install) echo "bun install out" ;;
  *) exec "${process.execPath}" "$@" ;;
esac`,
    )
    Bun.spawnSync(['chmod', '+x', join(bun.dir, '.fakebin/bun')])
    return bun
  }

  test('deps update --json: one document last, bun output on stderr', async () => {
    const bun = bunWorkspace()
    try {
      const r = await bun.kit(['deps', 'update', '--json'])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ dryRun: false, ok: true, packages: ['left-pad'] })
      expect(r.stderr).toContain('bun update out')
      expect(r.stderr).toContain('bun install out')
    } finally {
      bun.cleanup()
    }
  })

  test('deps --json: the outdated table as rows', async () => {
    const bun = bunWorkspace()
    try {
      const r = await bun.kit(['deps', '--json'])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({
        ok: true,
        outdated: [{ package: 'left-pad', current: '1.0.0', update: '1.3.0', latest: '1.3.0' }],
      })
    } finally {
      bun.cleanup()
    }
  })

  test('deps latest --json: install runs before the document, which is the only stdout', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ version: '2.0.0' }) })
    const bun = bunWorkspace()
    try {
      const r = await bun.kit(['deps', 'latest', 'left-pad', '--json'], {
        env: { npm_config_registry: `http://localhost:${server.port}` },
      })
      expect(r.code).toBe(0)
      const doc = JSON.parse(r.stdout)
      expect(doc).toMatchObject({ dryRun: false, ok: true, restored: [] })
      expect(doc.edits[0].change).toEqual({ field: 'dependencies', from: '^1.0.0', to: '^2.0.0' })
      expect(r.stderr).toContain('bun install out')
    } finally {
      bun.cleanup()
      server.stop(true)
    }
  })

  test('deps update: a forced exit mid-update still restores the manifest', async () => {
    // `bun update` rewrites the manifest, then ignores SIGINT; the second Ctrl-C forces kit out.
    const bun = bunWorkspace(
      `trap '' INT; echo '{"rewritten":true}' > package.json; touch .updating; sleep 10`,
    )
    try {
      const original = readFileSync(join(bun.dir, 'package.json'), 'utf8')
      const proc = bun.spawn(['deps', 'update'])
      for (let i = 0; i < 100 && !existsSync(join(bun.dir, '.updating')); i++) await Bun.sleep(50)
      expect(readFileSync(join(bun.dir, 'package.json'), 'utf8')).toContain('rewritten')
      proc.kill('SIGINT')
      await Bun.sleep(100)
      proc.kill('SIGINT')
      expect(await proc.exited).toBe(130)
      expect(readFileSync(join(bun.dir, 'package.json'), 'utf8')).toBe(original)
    } finally {
      bun.cleanup()
    }
  })

  test('help lists the setup commands outside a project', async () => {
    const r = await fx.kit(['--help'], { cwd: '..' })
    expect(r.code).toBe(0)
    for (const name of ['doctor', 'init', 'deps', 'gradle', 'wrangler', 'xcode'])
      expect(r.stdout).toContain(name)
  })
})
