import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { findMaestro } from '../../src/lib/maestro/bin'
import { flowFiles } from '../../src/lib/maestro/lint'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit add maestro` in fixture copies: files, idempotency, --force, the config edit, and lint-clean flows. */

let f: Fixture
afterEach(() => f.cleanup())

const read = (p: string) => readFileSync(join(f.dir, p), 'utf8')
const has = (p: string) => existsSync(join(f.dir, p))
const put = (p: string, text: string) => {
  mkdirSync(join(f.dir, p, '..'), { recursive: true })
  writeFileSync(join(f.dir, p), text)
}

const FILES = ['config.yaml', 'flows/smoke.yaml', 'subflows/settle.yaml', 'README.md', '.gitignore']

/** setup-repo: only a release.android block, no maestro block. */
const bare = () => {
  f = fixture('setup-repo', [])
}

describe('kit add maestro', () => {
  test('no maestro block: writes the flows dir and adds the block to the config', async () => {
    bare()
    const before = read('kit.config.ts')
    const r = await f.kit(['add', 'maestro'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    for (const file of FILES) expect(has(`maestro/${file}`)).toBe(true)
    expect(read('kit.config.ts')).toBe(
      before.replace(
        "  release: { android: { packageName: 'app.setup', module: ':android' } },\n",
        "  release: { android: { packageName: 'app.setup', module: ':android' } },\n  maestro: {\n    dir: 'maestro',\n    version: '2.9.0',\n  },\n",
      ),
    )
    // The Android id comes from release.android; there is no iOS id, so every flow uses it.
    expect(read('maestro/flows/smoke.yaml')).toStartWith(
      'appId: app.setup\nname: smoke\ntags:\n  - smoke\n---\n',
    )
    expect(read('maestro/subflows/settle.yaml')).toStartWith('appId: app.setup\n---\n')
    expect(read('maestro/config.yaml')).toContain('- flows/*')
    expect(read('maestro/.gitignore')).toBe('output/\n')
    const readme = read('maestro/README.md')
    for (const rule of [
      'The settle gate',
      'Launch switches',
      'Taps that lie',
      'No pixel baselines',
      'Motion',
    ]) {
      expect(readme).toContain(`## ${rule}`)
    }
    expect(readme).not.toContain('—')
    expect(r.stderr).toContain('added maestro')
    expect(r.stderr).toContain('kit qa android')
    // The config loads and carries the block.
    const cfg = JSON.parse((await f.kit(['config'])).stdout).config
    expect(cfg.maestro).toEqual({ dir: 'maestro', version: '2.9.0' })
    expect(f.calls()).toEqual([])
  })

  test('--dir and flags: ids from flags, differing ids launch per platform', async () => {
    bare()
    const r = await f.kit([
      'add',
      'maestro',
      '--dir',
      'apps/client/maestro',
      '--ios',
      'app.setup.ios',
      '--android',
      'app.setup',
    ])
    expect(r.code).toBe(0)
    expect(read('kit.config.ts')).toContain("    dir: 'apps/client/maestro',\n    version: '2.9.0',")
    const smoke = read('apps/client/maestro/flows/smoke.yaml')
    expect(smoke).toStartWith('appId: app.setup.ios\n')
    expect(smoke).toContain('platform: iOS')
    expect(smoke).toContain('appId: app.setup\n')
    expect(smoke).toContain('platform: Android')
    expect(r.stderr).toContain('kit qa ios')
    expect(r.stderr).toContain('kit qa android')
  })

  test('idempotent: a second run keeps every file and writes nothing', async () => {
    bare()
    expect((await f.kit(['add', 'maestro'])).code).toBe(0)
    const config = read('kit.config.ts')
    put('maestro/flows/smoke.yaml', 'appId: mine\n---\n- launchApp\n')
    const r = await f.kit(['add', 'maestro'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('maestro/flows/smoke.yaml  exists')
    expect(read('maestro/flows/smoke.yaml')).toBe('appId: mine\n---\n- launchApp\n')
    expect(read('kit.config.ts')).toBe(config)
  })

  test('a deleted file comes back without touching the others', async () => {
    bare()
    await f.kit(['add', 'maestro'])
    put('maestro/README.md', 'edited\n')
    const { rmSync } = await import('node:fs')
    rmSync(join(f.dir, 'maestro/subflows/settle.yaml'))
    expect((await f.kit(['add', 'maestro'])).code).toBe(0)
    expect(has('maestro/subflows/settle.yaml')).toBe(true)
    expect(read('maestro/README.md')).toBe('edited\n')
  })

  test('--force overwrites the files', async () => {
    bare()
    await f.kit(['add', 'maestro'])
    put('maestro/flows/smoke.yaml', 'mine\n')
    put('maestro/README.md', 'mine\n')
    const r = await f.kit(['add', 'maestro', '--force'])
    expect(r.code).toBe(0)
    expect(read('maestro/flows/smoke.yaml')).toStartWith('appId: app.setup\n')
    expect(read('maestro/README.md')).toStartWith('# Maestro flows')
  })

  test('--dry-run --json: the plan on stdout, nothing written', async () => {
    bare()
    const before = read('kit.config.ts')
    const r = await f.kit(['add', 'maestro', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ ok: true, dryRun: true, add: 'maestro', dir: 'maestro' })
    expect(out.files.map((x: { path: string }) => x.path)).toEqual([
      'kit.config.ts',
      ...FILES.map((x) => `maestro/${x}`),
    ])
    expect(has('maestro')).toBe(false)
    expect(read('kit.config.ts')).toBe(before)
  })

  test('a config with a maestro block: its dir and its qa tags are used, the config is untouched', async () => {
    f = fixture('maestro-app', [])
    const before = read('kit.config.ts')
    // The fixture's qa suite runs [['smoke'], ['onboarding']]: the smoke flow takes the first stage.
    const r = await f.kit(['add', 'maestro', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    const paths = JSON.parse(r.stdout).files.map((x: { path: string; kind: string }) => `${x.kind} ${x.path}`)
    expect(paths).not.toContain('edit kit.config.ts')
    expect(paths).toContain('skip maestro/config.yaml')
    expect(paths).toContain('write maestro/subflows/settle.yaml')
    const w = await f.kit(['add', 'maestro'])
    expect(w.code).toBe(0)
    // app.ios and app.android in the fixture differ only in platform: both ids are the same here.
    expect(read('maestro/config.yaml')).toBe('flows:\n  - flows/*\n')
    expect(read('kit.config.ts')).toBe(before)
    expect(read('maestro/subflows/settle.yaml')).toStartWith('appId: app.example\n')
    const rerun = await f.kit(['add', 'maestro', '--dir', 'elsewhere'])
    expect(rerun.code).toBe(2)
    expect(rerun.stderr).toContain('differs from maestro.dir')
  })

  test('a config kit cannot edit: nothing is written, the block goes to stdout, exit 1', async () => {
    bare()
    put(
      'kit.config.ts',
      "const base = { name: 'x' }\nexport default { ...base, release: { android: { packageName: 'a.b', module: ':a' } } }\n",
    )
    const before = read('kit.config.ts')
    const r = await f.kit(['add', 'maestro'])
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("maestro: { dir: 'maestro', version: '2.9.0' },\n")
    expect(has('maestro')).toBe(false)
    expect(read('kit.config.ts')).toBe(before)
    const json = await f.kit(['add', 'maestro', '--json'])
    expect(json.code).toBe(1)
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      snippet: "maestro: { dir: 'maestro', version: '2.9.0' },",
    })
  })

  test('no app id anywhere and no terminal: a usage error naming the flags', async () => {
    bare()
    put('kit.config.ts', "export default { name: 'x' }\n")
    const r = await f.kit(['add', 'maestro'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--ios')
    expect(has('maestro')).toBe(false)
    const bad = await f.kit(['add', 'maestro', '--ios', 'not an id'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('is not an app id')
  })

  test('the scaffold is what kit lint checks: two flow files, no config.yaml, no README', async () => {
    bare()
    await f.kit(['add', 'maestro'])
    const config = configSchema.parse({ name: 'x', maestro: { dir: 'maestro' } })
    expect(flowFiles(f.dir, config)).toEqual(['maestro/flows/smoke.yaml', 'maestro/subflows/settle.yaml'])
  })

  test('every scaffolded flow parses as YAML with Maestro header and commands', async () => {
    bare()
    await f.kit(['add', 'maestro', '--ios', 'app.setup.ios', '--android', 'app.setup'])
    for (const file of ['flows/smoke.yaml', 'subflows/settle.yaml', 'config.yaml']) {
      expect(() => Bun.YAML.parse(read(`maestro/${file}`))).not.toThrow()
    }
    const [header, steps] = Bun.YAML.parse(read('maestro/flows/smoke.yaml')) as [
      { appId: string; name: string; tags: string[] },
      { runFlow: unknown }[],
    ]
    expect(header).toEqual({ appId: 'app.setup.ios', name: 'smoke', tags: ['smoke'] })
    expect(steps.filter((s) => 'runFlow' in s)).toHaveLength(3)
  })

  // The real Maestro, when installed: the same `check-syntax` `kit lint` runs. A JVM start per file.
  const maestro = findMaestro()
  test.skipIf(maestro === undefined)(
    'maestro check-syntax passes on the scaffolded flows (one id and two ids)',
    async () => {
      for (const flags of [[], ['--ios', 'app.setup.ios', '--android', 'app.setup']]) {
        bare()
        await f.kit(['add', 'maestro', ...flags])
        for (const file of ['flows/smoke.yaml', 'subflows/settle.yaml']) {
          const proc = Bun.spawn([maestro!, 'check-syntax', join(f.dir, `maestro/${file}`)], {
            cwd: f.dir,
            env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_DISABLE_UPDATE_CHECK: 'true' },
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const [out, err] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ])
          expect({ file, code: await proc.exited, out: out + err }).toMatchObject({ file, code: 0 })
        }
        f.cleanup()
      }
    },
    120_000,
  )
})
