import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { CATALOG_KEYS, checkCatalogKeys, checkCiPin, parseEnvKeys } from '../../src/commands/doctor'
import { configSchema } from '../../src/config/schema'
import { parseToml } from '../../src/lib/toml'

// templates/new: the new-repo scaffold. Each file must parse once its {{placeholders}} are filled.
const KIT = resolve(import.meta.dir, '../..')
const NEW = join(KIT, 'templates/new')
const VARS: Record<string, string> = { name: 'Demo', kitVersion: pkg.version, bun: Bun.version }
const render = (file: string) => {
  const text = readFileSync(join(NEW, file), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k: string) => VARS[k] ?? m)
  expect(text).not.toMatch(/\{\{\w+\}\}/)
  return text
}

const tmp = mkdtempSync(join(tmpdir(), 'kit-templates-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('templates/new', () => {
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
