import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { CATALOG_KEYS, checkCatalogKeys, checkCiPin, parseEnvKeys } from '../../src/commands/doctor'
import { configSchema } from '../../src/config/schema'
import { stripJsonc } from '../../src/lib/cloudflare'
import { usesRef } from '../../src/lib/kitref'
import { parseToml } from '../../src/lib/toml'

// templates/gradle and templates/toolchain: the new-repo scaffolds. Each file must parse once its {{placeholders}} are filled.
const KIT = resolve(import.meta.dir, '../..')
const NEW = join(KIT, 'templates/gradle')
const TOOLCHAIN = join(KIT, 'templates/toolchain')
const SHA = 'c'.repeat(40)
const VARS: Record<string, string> = {
  name: 'Demo',
  kitVersion: pkg.version,
  kitRef: usesRef(pkg.version, SHA),
  platformArgs: ' -- --platform jvm',
  bun: Bun.version,
}
const render = (file: string, dir = NEW) => {
  const text = readFileSync(join(dir, file), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k: string) => VARS[k] ?? m)
  expect(text).not.toMatch(/\{\{\w+\}\}/)
  return text
}

const tmp = mkdtempSync(join(tmpdir(), 'kit-templates-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('templates/gradle', () => {
  test('libs.versions.toml parses and has every catalog key kit reads', () => {
    const catalog = parseToml(render('apps/client/gradle/libs.versions.toml'))
    expect(checkCatalogKeys('libs.versions.toml', catalog).status).toBe('ok')
    expect(Object.keys(catalog.versions as object)).toEqual(expect.arrayContaining([...CATALOG_KEYS]))
  })

  test('mise.toml parses', () => {
    expect(
      parseToml(readFileSync(join(KIT, 'templates/mise.toml'), 'utf8').replace('{{bun}}', '1')),
    ).toHaveProperty('tools')
  })

  test('ci.yml parses, runs kit check/test/build, and pins the setup action to the kit version', () => {
    const text = render('.github/workflows/ci.yml')
    const wf = Bun.YAML.parse(text) as { jobs: Record<string, { steps: { run?: string; uses?: string }[] }> }
    const runs = Object.values(wf.jobs).flatMap((j) => j.steps.flatMap((s) => (s.run ? [s.run] : [])))
    expect(runs).toEqual([
      './node_modules/.bin/kit check',
      './node_modules/.bin/kit test',
      './node_modules/.bin/kit build',
    ])
    expect(checkCiPin([{ file: 'ci.yml', text }], `^${pkg.version}`, true).status).toBe('ok')
  })

  test('.env.example names keys and holds no values', () => {
    const text = render('.env.example')
    expect(parseEnvKeys(text)).toContain('ASC_KEY_ID')
    for (const line of text.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) expect(line).toMatch(/=$/)
  })

  test('Fastfile is the one-line import of the shared Fastfile (D7)', () => {
    expect(render('apps/client/fastlane/Fastfile').trim().split('\n')).toEqual([
      'import(ENV.fetch("KIT_FASTFILE") { UI.user_error!("Run fastlane via `kit fastlane ...` or `kit release ...`") })',
    ])
  })

  test('renovate.json extends the kit preset', () => {
    const config = JSON.parse(render('renovate.json', NEW)) as { extends: string[] }
    expect(config.extends).toEqual(['config:recommended', 'github>jordond/kit//renovate/default'])
    expect(existsSync(join(KIT, 'renovate/default.json'))).toBe(true)
  })

  test('settings.gradle.kts resolves kit plugins from node_modules and applies kit.settings', () => {
    const text = render('apps/client/settings.gradle.kts')
    expect(text).toContain('node_modules/@jordond/kit')
    expect(text).toContain('plugins { id("io.github.jordond.kit.settings") }')
    expect(text).toContain('rootProject.name = "Demo"')
  })

  test('kit.config.ts type-checks against src/index.ts and validates', async () => {
    const config = join(tmp, 'kit.config.ts')
    writeFileSync(config, render('kit.config.ts').replace("'@jordond/kit'", `'${join(KIT, 'src/index.ts')}'`))
    writeFileSync(
      join(tmp, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'Preserve',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          typeRoots: [join(KIT, 'node_modules/@types')],
          types: ['bun'],
        },
        files: ['kit.config.ts'],
      }),
    )
    const tsc = Bun.spawnSync([join(KIT, 'node_modules/.bin/tsc'), '-p', tmp], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(`${tsc.stdout}${tsc.stderr}`).toBe('')
    expect(tsc.exitCode).toBe(0)
    const parsed = configSchema.safeParse((await import(config)).default)
    expect(parsed.error).toBeUndefined()
    expect(parsed.data?.gradle?.root).toBe('apps/client')
  })
})

describe('templates/toolchain', () => {
  type Workflow = { jobs: Record<string, { uses?: string; steps?: { run?: string; uses?: string }[] }> }

  test('mise.toml pins bun and ktlint, and no java', () => {
    const tools = parseToml(render('mise.toml', TOOLCHAIN)).tools as Record<string, string>
    expect(Object.keys(tools)).toEqual(['bun', 'ktlint'])
  })

  test('ci.yml lints, tests and builds through kit, pinned to the kit SHA', () => {
    const text = render('.github/workflows/ci.yml', TOOLCHAIN)
    const wf = Bun.YAML.parse(text) as Workflow
    const runs = Object.values(wf.jobs).flatMap((j) => (j.steps ?? []).flatMap((s) => (s.run ? [s.run] : [])))
    expect(runs).toEqual(['kit lint', 'kit test -- --platform jvm', 'kit build -- --platform jvm'])
    expect(text).toContain(`jordond/kit/.github/actions/setup@${SHA} # v${pkg.version}`)
    expect(text).not.toContain('java:')
    expect(checkCiPin([{ file: 'ci.yml', text }], `^${pkg.version}`, true).status).toBe('ok')
  })

  test('distribute.yml calls the reusable workflow at the same pin', () => {
    const text = render('.github/workflows/distribute.yml', TOOLCHAIN)
    const wf = Bun.YAML.parse(text) as Workflow
    expect(wf.jobs.distribute?.uses).toBe(`jordond/kit/.github/workflows/mobile-distribute.yml@${SHA}`)
    expect(checkCiPin([{ file: 'distribute.yml', text }], `^${pkg.version}`, true).status).toBe('ok')
  })

  test('.env.example and the Fastfile match the gradle template', () => {
    expect(render('.env.example', TOOLCHAIN)).toBe(render('.env.example'))
    expect(render('fastlane/Fastfile', TOOLCHAIN)).toBe(render('apps/client/fastlane/Fastfile'))
  })

  test('renovate.json extends the kit preset', () => {
    const config = JSON.parse(render('renovate.json', TOOLCHAIN)) as { extends: string[] }
    expect(config.extends).toEqual(['config:recommended', 'github>jordond/kit//renovate/default'])
    expect(existsSync(join(KIT, 'renovate/default.json'))).toBe(true)
  })

  test('.editorconfig styles Kotlin for ktlint', () => {
    expect(render('.editorconfig', TOOLCHAIN)).toContain('[*.{kt,kts}]\nindent_size = 2')
  })
})

// templates/add: what `kit add module` and `kit add target` write (src/lib/add/plan.ts fills them).
describe('templates/add', () => {
  const ADD = join(KIT, 'templates/add')
  const ADD_VARS: Record<string, string> = {
    compose: '\n    id("io.github.jordond.kit.compose")',
    targets: '        android()\n        jvm()',
    package: 'com.example.app.core',
    module: ':core',
    platforms: 'android, jvm',
    settings: '\nsettings:\n  compose:\n    enabled: true',
    worker: 'api',
    date: '2026-01-02',
  }
  const add = (file: string) => {
    const text = readFileSync(join(ADD, file), 'utf8').replace(
      /\{\{(\w+)\}\}/g,
      (m, k: string) => ADD_VARS[k] ?? m,
    )
    expect(text).not.toMatch(/\{\{\w+\}\}/)
    return text
  }

  test('every file is one the plans render, and nothing lands in the init templates', () => {
    const files = [...new Bun.Glob('**/*').scanSync({ cwd: ADD, onlyFiles: true, dot: true })].sort()
    expect(files).toEqual([
      'Placeholder.kt',
      'gradle-module/build.gradle.kts',
      'toolchain-module/module.yaml',
      'worker/package.json',
      'worker/src/index.ts',
      'worker/tsconfig.json',
      'worker/wrangler.jsonc',
    ])
    for (const file of files) add(file)
  })

  test('gradle module: only kit plugin ids, and the kit { targets { } } block', () => {
    const text = add('gradle-module/build.gradle.kts')
    expect([...text.matchAll(/id\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      'io.github.jordond.kit.kmp.library',
      'io.github.jordond.kit.compose',
    ])
    expect(text).toContain('kit {\n    targets {\n        android()\n        jvm()\n    }\n}')
    expect(add('Placeholder.kt')).toStartWith('package com.example.app.core\n')
  })

  test('toolchain module.yaml parses as a kmp/lib product', () => {
    expect(Bun.YAML.parse(add('toolchain-module/module.yaml'))).toEqual({
      product: { type: 'kmp/lib', platforms: ['android', 'jvm'] },
      settings: { compose: { enabled: true } },
    })
  })

  test('worker: JSON files parse; wrangler.jsonc has a name and no account id', () => {
    const wrangler = JSON.parse(stripJsonc(add('worker/wrangler.jsonc')))
    expect(wrangler).toMatchObject({ name: 'api', main: 'src/index.ts', compatibility_date: '2026-01-02' })
    expect(wrangler).not.toHaveProperty('account_id')
    expect(Object.keys(JSON.parse(add('worker/package.json')).scripts)).toEqual(
      expect.arrayContaining(['dev', 'deploy', 'typecheck']),
    )
    expect(JSON.parse(add('worker/tsconfig.json')).compilerOptions.strict).toBe(true)
  })

  test('worker src/index.ts type-checks with its own tsconfig', () => {
    const dir = join(tmp, 'worker')
    cpSync(join(ADD, 'worker'), dir, { recursive: true })
    writeFileSync(join(dir, 'src/index.ts'), add('worker/src/index.ts'))
    const tsc = Bun.spawnSync([join(KIT, 'node_modules/.bin/tsc'), '-p', dir], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(`${tsc.stdout}${tsc.stderr}`).toBe('')
    expect(tsc.exitCode).toBe(0)
  })
})
