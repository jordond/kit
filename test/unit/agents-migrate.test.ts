import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { type MigrateFacts, migrateFacts, migratePrompt, migrateRoot } from '../../src/lib/agents-migrate'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-migrate-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const paths = (facts: MigrateFacts) => facts.found.map((f) => f.path)
const base: MigrateFacts = { kitDir: '.', installed: false, found: [], more: 0 }

describe('migrateFacts', () => {
  test('finds scripts, task runners, CI, hooks and wrappers; skips deps and build output', () => {
    const root = repo({
      'package.json': JSON.stringify({
        scripts: { build: 'tsc', 'gen:icons': 'sh scripts/icons.sh' },
        husky: {},
      }),
      'scripts/icons.sh': '',
      'scripts/release': '#!/bin/sh\n',
      'scripts/LICENSE': 'MIT',
      'scripts/README.md': '',
      'apps/api/scripts/deploy.sh': '',
      'x-package.json': '{}',
      Makefile: '',
      Jenkinsfile: '',
      'apps/client/gradlew': '',
      'apps/api/wrangler.toml': '',
      '.github/workflows/ci.yml': '',
      'lefthook.yml': '',
      'node_modules/x/package.json': JSON.stringify({ scripts: { a: 'b' } }),
      'apps/client/build/scripts/x.sh': '',
    })
    const facts = migrateFacts(root)
    expect(paths(facts)).toEqual(
      expect.arrayContaining([
        'scripts/icons.sh',
        'scripts/release',
        'apps/api/scripts/deploy.sh',
        'Makefile',
        'Jenkinsfile',
        'apps/client/gradlew',
        'apps/api/wrangler.toml',
        '.github/workflows/ci.yml',
        'lefthook.yml',
      ]),
    )
    for (const p of ['scripts/LICENSE', 'scripts/README.md', 'x-package.json'])
      expect(paths(facts)).not.toContain(p)
    expect(paths(facts).some((p) => p.includes('node_modules') || p.includes('/build/'))).toBe(false)
    expect(facts.found.find((f) => f.path === 'package.json')?.what).toBe(
      'scripts: build, gen:icons; git hooks config: husky',
    )
    expect(facts).toMatchObject({ configPath: undefined, kitDir: '.', installed: false, more: 0 })
  })

  test('a malformed package.json is skipped, not fatal', () => {
    expect(paths(migrateFacts(repo({ 'package.json': '{', Makefile: '' })))).toEqual(['Makefile'])
  })

  test('symlinks are not followed', () => {
    const outside = repo({ 'scripts/secret.sh': '' })
    const root = repo({ Makefile: '' })
    symlinkSync(outside, join(root, 'linked'))
    expect(paths(migrateFacts(root))).toEqual(['Makefile'])
  })

  test('long inventories are capped and counted', () => {
    const files = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`scripts/s${String(i).padStart(2, '0')}.sh`, '']),
    )
    const facts = migrateFacts(repo(files))
    expect(facts.found).toHaveLength(60)
    expect(facts.more).toBe(10)
  })

  test('the cap keeps the shallow findings', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ scripts: { a: 'b' } }),
      'turbo.json': '',
    }
    for (let i = 0; i < 70; i++)
      files[`apps/a${String(i).padStart(2, '0')}/package.json`] = JSON.stringify({ scripts: { a: 'b' } })
    expect(paths(migrateFacts(repo(files))).slice(0, 2)).toEqual(['package.json', 'turbo.json'])
  })

  test('kit goes in .kit for a toolchain project, nested or not, without a root package.json', () => {
    expect(migrateFacts(repo({ kotlin: '', 'project.yaml': '' })).kitDir).toBe('.kit')
    expect(migrateFacts(repo({ 'apps/x/kotlin': '', 'apps/x/project.yaml': '' })).kitDir).toBe('.kit')
    expect(migrateFacts(repo({ kotlin: '', 'project.yaml': '', 'package.json': '{}' })).kitDir).toBe('.')
  })

  test('an existing .kit install, its config and targets', () => {
    const root = repo({
      '.kit/package.json': JSON.stringify({ devDependencies: { '@jordond/kit': '^0.11.0' } }),
      '.kit/kit.config.ts': '',
    })
    const config = configSchema.parse({ name: 'x', targets: { api: { kind: 'worker', dir: 'apps/api' } } })
    expect(migrateFacts(root, config)).toMatchObject({
      kitDir: '.kit',
      installed: true,
      configPath: '.kit/kit.config.ts',
      targets: ['api (worker)'],
    })
  })
})

describe('migrateRoot', () => {
  test('the git root above the directory, else the directory', () => {
    const root = repo({ '.git/HEAD': '', 'apps/api/x': '' })
    expect(migrateRoot(join(root, 'apps/api'))).toBe(root)
    const bare = repo({ 'a/x': '' })
    expect(migrateRoot(join(bare, 'a'))).toBe(join(bare, 'a'))
  })
})

describe('migratePrompt', () => {
  test('points custom scripts at repo commands and lists what kit found', () => {
    const prompt = migratePrompt(
      { ...base, found: [{ path: 'scripts/icons.sh', what: 'script' }], more: 3 },
      '1.2.3',
    )
    expect(prompt).toContain('# Migrate this repo to kit')
    expect(prompt).toContain('`.kit/commands/<name>.ts`')
    expect(prompt).toContain("import { defineCommand, runOrThrow } from '@jordond/kit'")
    expect(prompt).toContain('- `scripts/icons.sh`: script')
    expect(prompt).toContain('…and 3 more')
    expect(prompt).toContain('There is no kit config yet.')
    expect(prompt).toContain('`./node_modules/.bin/kit agents sync`')
    expect(prompt).toContain('blob/v1.2.3/docs/CONFIG.md')
    expect(prompt).toContain('jordond/kit/.github/actions/setup@<sha> # v1.2.3')
    expect(prompt).toContain("'refs/tags/v1.2.3^{}'")
    expect(prompt).not.toContain('doctor --fix')
  })

  test('starts on a clean branch, takes a baseline, and waits for approval before writing', () => {
    const prompt = migratePrompt(base, '1.2.3')
    const order = [
      '## 0. Start clean',
      '## 1. Inventory',
      '## 2. Baseline',
      '## 3. Show the plan and wait for approval',
      '## 4. Install kit',
    ].map((h) => prompt.indexOf(h))
    expect(order.every((i) => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(prompt).toContain('`git status`')
    expect(prompt).toContain('Proceed only on an explicit yes')
  })

  test('keeps package.json scripts a kind default runs, and build-tool callers', () => {
    const prompt = migratePrompt(base, '1.2.3')
    expect(prompt).toContain('a missing script skips the verb')
    expect(prompt).toContain('kit never sits inside a build')
  })

  test('.kit install, already installed, and a started migration', () => {
    const fresh = migratePrompt({ ...base, kitDir: '.kit' }, '1.2.3')
    expect(fresh).toContain('(cd .kit && bun add -d @jordond/kit)')
    expect(fresh).toContain('`./.kit/node_modules/.bin/kit doctor --ci`')
    const started = migratePrompt(
      {
        ...base,
        kitDir: '.kit',
        installed: true,
        configPath: '.kit/kit.config.ts',
        targets: ['app (kotlin)'],
      },
      '1.2.3',
    )
    expect(started).toContain('kit is already a dependency in `.kit/package.json`')
    expect(started).not.toContain('bun add -d')
    expect(started).toContain(
      'A kit config already exists at `.kit/kit.config.ts` with targets `app (kotlin)`',
    )
  })
})
