import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Installs kit the way a consumer repo does: from the packed tarball, not a `file:` directory dependency
// (that would symlink the whole checkout, kit's own dev zod included). Slow, so opt-in: KIT_PACK_TEST=1.
const enabled = process.env.KIT_PACK_TEST === '1'
const KIT = resolve(import.meta.dir, '../..')
const STALE = 'stale-build-canary.js'
const pkg = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')) as {
  version: string
  devDependencies: Record<string, string>
}

let tmp = ''
let app = ''

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, CI: 'true', NO_COLOR: '1', KIT_ROOT: '', KIT_DEV: '', ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, stdout, stderr }
}

async function ok(cmd: string[], cwd: string) {
  const r = await sh(cmd, cwd)
  if (r.code !== 0) throw new Error(`${cmd.join(' ')} exited ${r.code}\n${r.stdout}\n${r.stderr}`)
  return r
}

const kit = (args: string[]) => sh([join(app, 'node_modules/.bin/kit'), ...args], app)

describe.skipIf(!enabled)('packed tarball', () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kit-pack-'))
    // A leftover from an earlier build; `bun run build` must start from an empty dist so it never ships.
    mkdirSync(join(KIT, 'dist'), { recursive: true })
    writeFileSync(join(KIT, 'dist', STALE), '')
    await ok(['bun', 'run', 'build'], KIT)
    const out = join(tmp, 'pack')
    await ok(['bun', 'pm', 'pack', '--destination', out], KIT)
    const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'))
    if (!tarball) throw new Error(`bun pm pack wrote no tarball to ${out}`)

    app = join(tmp, 'app')
    cpSync(join(KIT, 'test/fixtures/bun-workers'), app, { recursive: true })
    rmSync(join(app, 'bun.lock'), { force: true })
    // The fixture config as an app writes it: through defineConfig, so the import must resolve at runtime too.
    const config = readFileSync(join(app, 'kit.config.ts'), 'utf8').replace(
      /^export default (\{[\s\S]*\})\s*$/m,
      "import { defineConfig } from '@jordond/kit'\n\nexport default defineConfig($1)\n",
    )
    if (!config.includes('defineConfig(')) throw new Error('could not rewrite the fixture kit.config.ts')
    writeFileSync(join(app, 'kit.config.ts'), config)
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify(
        {
          name: 'kit-pack-app',
          private: true,
          type: 'module',
          devDependencies: { '@jordond/kit': join(out, tarball), zod: pkg.devDependencies.zod },
        },
        null,
        2,
      ),
    )
    writeFileSync(
      join(app, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'Preserve',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['kit.config.ts'],
      }),
    )
    await ok(['bun', 'install'], app)
  }, 180_000)

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  test('the tarball ships dist, the launcher and fastlane, and one zod', () => {
    const installed = join(app, 'node_modules/@jordond/kit')
    const files = readdirSync(installed)
    expect(files).toContain('bin')
    expect(files).toContain('dist')
    expect(files).toContain('fastlane')
    expect(readdirSync(join(installed, 'dist'))).toContain('cli.js')
    // The page headless Chrome runs for `kit shots export`, built for the browser.
    expect(readdirSync(join(installed, 'dist'))).toContain('shots-page.js')
    // The built editor of `kit shots studio`, served as static files.
    expect(readdirSync(join(installed, 'dist/shots-editor'))).toContain('index.html')
    // zod is a peer: kit's bundle must use the app's copy, never a nested one.
    expect(readdirSync(installed)).not.toContain('node_modules')
  })

  test('the tarball ships every template file, dotfiles included', () => {
    const shipped = join(app, 'node_modules/@jordond/kit/templates')
    const list = (dir: string) =>
      [...new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true, dot: true })].sort()
    expect(list(shipped)).toEqual(list(join(KIT, 'templates')))
    expect(list(shipped)).toEqual(
      expect.arrayContaining([
        'toolchain/.editorconfig',
        'toolchain/.env.example',
        'toolchain/.github/workflows/ci.yml',
        'toolchain/.github/workflows/distribute.yml',
        'gradle/.github/workflows/ci.yml',
        'gradle/renovate.json',
        'toolchain/renovate.json',
      ]),
    )
    // The Renovate preset is read from the GitHub repo, never from the package.
    expect(readdirSync(join(app, 'node_modules/@jordond/kit'))).not.toContain('renovate')
  })

  test('kit init --template runs from the built dist', async () => {
    // The scaffold reads package.json and templates/ from the installed package.
    const dir = mkdtempSync(join(tmpdir(), 'kit-pack-new-'))
    try {
      const proc = Bun.spawn(
        [
          join(app, 'node_modules/.bin/kit'),
          'init',
          '--template',
          'gradle',
          '--name',
          'Demo',
          '--dry-run',
          '--json',
        ],
        {
          cwd: dir,
          env: { ...process.env, KIT_ROOT: '', KIT_DEV: '', CI: 'true', KIT_REPO_URL: join(dir, 'none') },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(stderr).toBe('')
      expect(await proc.exited).toBe(0)
      const doc = JSON.parse(stdout) as { template: string; files: { path: string }[] }
      expect(doc.template).toBe('gradle')
      expect(doc.files.map((f) => f.path)).toContain('.github/workflows/ci.yml')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the tarball has no stale build output', () => {
    const dist = readdirSync(join(app, 'node_modules/@jordond/kit/dist'), { recursive: true }).map(String)
    expect(dist).not.toContain(STALE)
    expect(dist.filter((f) => f.includes('spike'))).toEqual([])
    // One build has one cli entry chunk set; earlier builds left several main-*.js chunks behind.
    expect(dist.filter((f) => /^main-.*\.js$/.test(f)).length).toBeLessThanOrEqual(1)
  })

  test('kit --help', async () => {
    const r = await kit(['--help'])
    expect(r.code).toBe(0)
    expect(`${r.stdout}${r.stderr}`).toContain('check')
  })

  test('kit -V prints the package version', async () => {
    const r = await kit(['-V'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(pkg.version)
  })

  test('kit check --dry-run --json prints one JSON document on stdout', async () => {
    const r = await kit(['check', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })

  test('kit.config.ts typechecks against the shipped .d.ts', async () => {
    const r = await sh([join(KIT, 'node_modules/.bin/tsc'), '-p', 'tsconfig.json'], app)
    expect(`${r.stdout}${r.stderr}`).toBe('')
    expect(r.code).toBe(0)
  })
})
