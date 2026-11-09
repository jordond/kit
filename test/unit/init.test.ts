import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type InitState, kitPackageRoot, planInit, renderTemplate } from '../../src/commands/init'
import { configSchema } from '../../src/config/schema'

const config = configSchema.parse({
  name: 'X',
  env: { outputs: { 'apps/api/.dev.vars': {} } },
  targets: {
    api: { kind: 'worker', dir: 'apps/api' },
    edge: { kind: 'worker', dir: 'apps/edge' },
    web: { kind: 'astro', dir: 'apps/web' },
  },
})

const state = (files: string[], over: Partial<InitState> = {}): InitState => ({
  root: '/r',
  config,
  exists: (p) => files.includes(p),
  pm: 'bun',
  accepted: [],
  self: ['kit'],
  exec: (_cwd, bin, ...args) => ['bun', 'x', bin, ...args],
  ...over,
})

const titles = (s: InitState) => planInit(s).map((a) => `${a.kind} ${a.title}`)

describe('planInit', () => {
  test('fresh clone: env file, install, env sync, wrangler types where a wrangler config exists', () => {
    expect(titles(state(['.env.example', 'package.json', 'apps/api/wrangler.jsonc']))).toEqual([
      'env-file .env from .env.example',
      'cmd bun install',
      'skip mise.toml',
      'skip lefthook.yml',
      'cmd kit env sync',
      'cmd wrangler types (api)',
    ])
  })

  test('env sync runs as a child kit with KIT_ROOT', () => {
    const sync = planInit(state([])).find((a) => a.title === 'kit env sync')
    expect(sync).toMatchObject({ cmd: ['kit', 'env', 'sync'], cwd: '/r', env: { KIT_ROOT: '/r' } })
  })

  test('idempotent: existing files are skipped with the reason', () => {
    const plan = planInit(
      state(['.env.example', '.env', '.mise.toml', 'lefthook.yml'], { accepted: ['mise', 'lefthook'] }),
    )
    expect(plan.filter((a) => a.kind === 'skip').map((a) => (a as { reason: string }).reason)).toEqual([
      'already exists',
      'no package.json',
      '.mise.toml exists',
      'lefthook.yml exists',
    ])
  })

  test('accepted scaffolds are written; declined ones carry the reason', () => {
    const plan = titles(state([], { accepted: ['lefthook'], declinedReason: 'no terminal' }))
    expect(plan).toContain('scaffold lefthook.yml')
    expect(plan).toContain('skip mise.toml')
  })

  test('outside a project: no env sync, no wrangler types', () => {
    expect(titles(state(['package.json'], { config: undefined }))).toEqual([
      'skip .env',
      'cmd bun install',
      'skip mise.toml',
      'skip lefthook.yml',
    ])
  })
})

describe('templates', () => {
  test('kitPackageRoot finds the templates', () => {
    const root = kitPackageRoot()
    expect(existsSync(join(root, 'templates/mise.toml'))).toBe(true)
    expect(existsSync(join(root, 'templates/lefthook.yml'))).toBe(true)
  })

  test('renderTemplate fills known placeholders and leaves the rest', () => {
    expect(renderTemplate('bun = "{{bun}}" {{other}}', { bun: '1.3.14' })).toBe('bun = "1.3.14" {{other}}')
  })
})
