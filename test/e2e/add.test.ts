import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit add module` (Gradle and Kotlin toolchain repos) and `kit add target`, in fixture copies. */

let f: Fixture
afterEach(() => f.cleanup())

const read = (p: string) => readFileSync(join(f.dir, p), 'utf8')
const has = (p: string) => existsSync(join(f.dir, p))
const put = (p: string, text: string) => {
  mkdirSync(join(f.dir, p, '..'), { recursive: true })
  writeFileSync(join(f.dir, p), text)
}
/** Every file under `dir`, repo-relative, sorted. */
const tree = (dir: string): string[] =>
  readdirSync(join(f.dir, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(f.dir.length + 1))
    .sort()
const config = async () => {
  const r = await f.kit(['config'])
  expect(r.code).toBe(0)
  return JSON.parse(r.stdout).config
}

const SETTINGS = 'apps/client/settings.gradle.kts'
const SETTINGS_TEXT = 'rootProject.name = "Setup"\n\ninclude(":shared", ":android") // apps\n'

describe('kit add module (Gradle)', () => {
  const gradle = () => {
    f = fixture('setup-repo', [])
    put(SETTINGS, SETTINGS_TEXT)
  }

  test('writes the module on kit plugins, includes it, and runs nothing', async () => {
    gradle()
    const r = await f.kit(['add', 'module', 'feature:login', '--compose', '--targets', 'android,jvm'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(tree('apps/client/feature')).toEqual([
      'apps/client/feature/login/build.gradle.kts',
      'apps/client/feature/login/src/commonMain/kotlin/com/example/setup/feature/login/Placeholder.kt',
    ])
    expect(read('apps/client/feature/login/build.gradle.kts')).toBe(
      [
        'plugins {',
        '    id("io.github.jordond.kit.kmp.library")',
        '    id("io.github.jordond.kit.compose")',
        '}',
        '',
        'kit {',
        '    targets {',
        '        android()',
        '        jvm()',
        '    }',
        '}',
        '',
      ].join('\n'),
    )
    expect(
      read('apps/client/feature/login/src/commonMain/kotlin/com/example/setup/feature/login/Placeholder.kt'),
    ).toStartWith('package com.example.setup.feature.login\n')
    expect(read(SETTINGS)).toBe(`${SETTINGS_TEXT}include(":feature:login")\n`)
    expect(r.stderr).toContain('added module :feature:login')
    expect(r.stderr).toContain('kit gradle :feature:login:assemble')
    expect(r.stderr).toContain('kit build client')
    expect(f.calls()).toEqual([])
    expect((await config()).gradle.root).toBe('apps/client')
  })

  test('--dry-run --json: the plan on stdout, nothing written', async () => {
    gradle()
    const r = await f.kit(['add', 'module', 'core', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      dryRun: true,
      add: 'module',
      name: ':core',
      dir: 'apps/client/core',
      next: ['kit gradle :core:assemble', 'kit build client'],
      files: [
        { kind: 'write', path: 'apps/client/core/build.gradle.kts' },
        {
          kind: 'write',
          path: 'apps/client/core/src/commonMain/kotlin/com/example/setup/core/Placeholder.kt',
        },
        { kind: 'edit', path: SETTINGS, note: 'include(":core")' },
      ],
    })
    expect(has('apps/client/core')).toBe(false)
    expect(read(SETTINGS)).toBe(SETTINGS_TEXT)
  })

  test('refuses to overwrite (exit 2, files listed, nothing changed); --force overwrites', async () => {
    gradle()
    put('apps/client/core/build.gradle.kts', '// mine\n')
    const r = await f.kit(['add', 'module', 'core'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('apps/client/core/build.gradle.kts')
    expect(r.stderr).toContain('--force')
    expect(read('apps/client/core/build.gradle.kts')).toBe('// mine\n')
    expect(read(SETTINGS)).toBe(SETTINGS_TEXT)
    expect(has('apps/client/core/src')).toBe(false)

    const json = await f.kit(['add', 'module', 'core', '--json'])
    expect(json.code).toBe(2)
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, exitCode: 2 })

    const forced = await f.kit(['add', 'module', 'core', '--force', '--json'])
    expect(forced.code).toBe(0)
    expect(JSON.parse(forced.stdout)).toMatchObject({ ok: true, dryRun: false, name: ':core' })
    expect(read('apps/client/core/build.gradle.kts')).toContain('io.github.jordond.kit.kmp.library')
    // The include is there now: a second forced run leaves the settings file alone.
    const settings = read(SETTINGS)
    expect((await f.kit(['add', 'module', ':core', '--force'])).code).toBe(0)
    expect(read(SETTINGS)).toBe(settings)
  })

  test('usage errors: no name, a bad name, an unknown target; no settings file is a precondition', async () => {
    gradle()
    expect((await f.kit(['add', 'module'])).code).toBe(2)
    expect((await f.kit(['add', 'module', 'core/ui'])).code).toBe(2)
    expect((await f.kit(['add', 'module', 'core', '--targets', 'wasm'])).code).toBe(2)
    expect((await f.kit(['add', 'module', 'core', '--dir', '../out'])).code).toBe(2)
    expect(has('apps/client/core')).toBe(false)
    f.cleanup()
    f = fixture('setup-repo', [])
    const r = await f.kit(['add', 'module', 'core'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('No settings.gradle.kts in apps/client')
  })
})

describe('kit add module (Kotlin toolchain)', () => {
  const CONFIG = '.kit/kit.config.ts'
  const CONFIG_TEXT = [
    "import { defineConfig } from '@jordond/kit'",
    '',
    'export default defineConfig({',
    "  name: 'Demo',",
    "  toolchain: { root: '.' },",
    '  targets: {',
    "    app: { kind: 'kotlin', dir: '.' },",
    '  },',
    '})',
    '',
  ].join('\n')
  const toolchain = () => {
    f = fixture('new-toolchain', [])
    put(CONFIG, CONFIG_TEXT)
  }

  test('writes module.yaml and registers the module in project.yaml', async () => {
    toolchain()
    const before = read('project.yaml')
    const r = await f.kit(['add', 'module', 'core', '--compose'])
    expect(r.code).toBe(0)
    expect(tree('core')).toEqual(['core/module.yaml', 'core/src/Placeholder.kt'])
    expect(Bun.YAML.parse(read('core/module.yaml'))).toEqual({
      product: { type: 'kmp/lib', platforms: ['android', 'iosArm64', 'iosSimulatorArm64', 'jvm'] },
      settings: { compose: { enabled: true } },
    })
    // The package starts with the Android app's id, read from androidApp/module.yaml.
    expect(read('core/src/Placeholder.kt')).toStartWith('package app.example.demo.core\n')
    expect(read('project.yaml')).toBe(before.replace('  - webApp\n', '  - webApp\n  - core\n'))
    expect(r.stderr).toContain('kit kotlin build -m core')
    expect((await config()).toolchain.root).toBe('.')
  })

  test('--dry-run writes nothing; an existing module is refused; nested names are a usage error', async () => {
    toolchain()
    const before = read('project.yaml')
    const dry = await f.kit(['add', 'module', 'core', '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.stderr).toContain('write core/module.yaml')
    expect(dry.stderr).toContain('edit project.yaml')
    expect(has('core')).toBe(false)
    expect(read('project.yaml')).toBe(before)

    const shared = read('shared/module.yaml')
    const r = await f.kit(['add', 'module', 'shared'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('shared/module.yaml')
    expect(read('shared/module.yaml')).toBe(shared)
    expect((await f.kit(['add', 'module', 'feature:login'])).code).toBe(2)
    expect((await f.kit(['add', 'module', 'core', '--dir', 'libs/other'])).code).toBe(2)
    expect(read('project.yaml')).toBe(before)
  })

  test('add target edits .kit/kit.config.ts, the config this repo uses', async () => {
    toolchain()
    const r = await f.kit(['add', 'target', 'site', '--kind', 'astro', '--dir', 'site'])
    expect(r.code).toBe(0)
    expect(read(CONFIG)).toBe(
      CONFIG_TEXT.replace('  },\n})', "    site: { kind: 'astro', dir: 'site' },\n  },\n})"),
    )
    expect(has('kit.config.ts')).toBe(false)
    expect(tree('site')).toEqual(['site/.gitkeep'])
    expect((await config()).targets.site).toEqual({ kind: 'astro', dir: 'site' })
  })
})

describe('kit add target', () => {
  const workers = () => {
    f = fixture('bun-workers', [])
  }

  test('worker in a new dir: the target, a minimal worker, the config still loads', async () => {
    workers()
    const before = read('kit.config.ts')
    const r = await f.kit(['add', 'target', 'jobs', '--kind', 'worker', '--dir', 'apps/jobs'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    const line =
      "    client: { kind: 'gradle', dir: 'apps/client', test: [':shared:test', ':android:test'] },\n"
    expect(read('kit.config.ts')).toBe(
      before.replace(line, `${line}    jobs: { kind: 'worker', dir: 'apps/jobs' },\n`),
    )
    expect(tree('apps/jobs')).toEqual([
      'apps/jobs/package.json',
      'apps/jobs/src/index.ts',
      'apps/jobs/tsconfig.json',
      'apps/jobs/wrangler.jsonc',
    ])
    const wrangler = read('apps/jobs/wrangler.jsonc')
    expect(wrangler).toContain('"name": "jobs"')
    expect(wrangler).not.toMatch(/"account_id"\s*:/)
    expect(r.stderr).toContain('kit build jobs')
    expect((await config()).targets.jobs).toEqual({ kind: 'worker', dir: 'apps/jobs' })
    expect(f.calls()).toEqual([])
  })

  test('an existing dir is only registered', async () => {
    workers()
    put('services/img/Dockerfile', 'FROM scratch\n')
    const r = await f.kit(['add', 'target', 'img', '--kind', 'docker', '--dir', './services/img/', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      dryRun: false,
      add: 'target',
      name: 'img',
      dir: 'services/img',
      next: ['kit build img'],
      files: [{ kind: 'edit', path: 'kit.config.ts', note: 'add target img' }],
    })
    expect(tree('services/img')).toEqual(['services/img/Dockerfile'])
    expect((await config()).targets.img).toEqual({ kind: 'docker', dir: 'services/img' })
  })

  test('--dry-run: the plan, nothing written', async () => {
    workers()
    const before = read('kit.config.ts')
    const r = await f.kit(['add', 'target', 'jobs', '--kind', 'worker', '--dir', 'apps/jobs', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('edit kit.config.ts')
    expect(r.stderr).toContain('write apps/jobs/wrangler.jsonc')
    expect(read('kit.config.ts')).toBe(before)
    expect(has('apps/jobs')).toBe(false)
  })

  test('a config kit cannot edit: nothing written, the snippet on stdout, exit 1', async () => {
    workers()
    const text = `const targets = {\n  api: { kind: 'worker', dir: 'apps/api' },\n}\nexport default { name: 'Fixture', targets }\n`
    put('kit.config.ts', text)
    const r = await f.kit(['add', 'target', 'jobs', '--kind', 'worker', '--dir', 'apps/jobs'])
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("jobs: { kind: 'worker', dir: 'apps/jobs' },\n")
    expect(r.stderr).toContain('nothing was written')
    expect(read('kit.config.ts')).toBe(text)
    expect(has('apps/jobs')).toBe(false)

    const json = await f.kit(['add', 'target', 'jobs', '--kind', 'worker', '--dir', 'apps/jobs', '--json'])
    expect(json.code).toBe(1)
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      file: 'kit.config.ts',
      snippet: "jobs: { kind: 'worker', dir: 'apps/jobs' },",
      exitCode: 1,
    })
    expect(read('kit.config.ts')).toBe(text)
  })

  test('an edit that leaves a config that does not validate is put back', async () => {
    workers()
    // Text kit can edit, but the default export is another object: the new target never reaches the config.
    const text = `const other = { name: 'Fixture', targets: {} }\nexport default {\n  name: 'Fixture',\n  targets: {\n    api: { kind: 'worker', dir: 'apps/api' },\n  },\n} && other\n`
    put('kit.config.ts', text)
    const r = await f.kit(['add', 'target', 'jobs', '--kind', 'worker', '--dir', 'apps/jobs'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('kit.config.ts was put back')
    expect(read('kit.config.ts')).toBe(text)
    expect(has('apps/jobs')).toBe(false)
  })

  test('usage errors (exit 2) change nothing', async () => {
    workers()
    const before = read('kit.config.ts')
    const add = (...args: string[]) => f.kit(['add', 'target', ...args])
    for (const args of [
      [],
      ['jobs'],
      ['jobs', '--kind', 'worker'],
      ['jobs', '--kind', 'lambda', '--dir', 'apps/jobs'],
      ['jobs', '--kind', 'gradle', '--dir', 'apps/jobs'],
      ['api', '--kind', 'worker', '--dir', 'apps/jobs'],
      ['build', '--kind', 'worker', '--dir', 'apps/jobs'],
      ['workspace', '--kind', 'worker', '--dir', 'apps/jobs'],
      ['my jobs', '--kind', 'worker', '--dir', 'apps/jobs'],
      ['jobs', '--kind', 'worker', '--dir', '../jobs'],
      ['jobs', '--kind', 'worker', '--dir', 'kit.config.ts'],
    ]) {
      const r = await add(...args)
      expect([args.join(' '), r.code]).toEqual([args.join(' '), 2])
    }
    expect(read('kit.config.ts')).toBe(before)
    expect(has('apps/jobs')).toBe(false)
  })

  test('outside a project: exit 3', async () => {
    workers()
    rmSync(join(f.dir, 'kit.config.ts'))
    expect((await f.kit(['add', 'target', 'jobs', '--kind', 'worker', '--dir', 'apps/jobs'])).code).toBe(3)
  })
})
