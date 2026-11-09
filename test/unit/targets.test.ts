import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { isGradleTask, planVerbs, selectTargets, targetCommands } from '../../src/lib/targets'

const root = resolve(import.meta.dir, '../fixtures/bun-workers')
const config = configSchema.parse((await import(`${root}/kit.config.ts`)).default)

describe('isGradleTask', () => {
  test.each([
    ['spotlessCheck', true],
    [':shared:testAndroidHostTest', true],
    ['assembleDebug', true],
    ['./gradlew build', false],
    ['bun run test', false],
  ])('%s → %p', (s, want) => expect(isGradleTask(s)).toBe(want))
})

describe('selectTargets', () => {
  test('no names: everything plus workspace', () => {
    const s = selectTargets(config)
    expect(s.workspace).toBe(true)
    expect(s.targets.map(([n]) => n)).toEqual(['api', 'web', 'client'])
  })
  test('a JS target pulls in the workspace; a gradle one does not', () => {
    expect(selectTargets(config, ['api']).workspace).toBe(true)
    expect(selectTargets(config, ['client']).workspace).toBe(false)
    expect(selectTargets(config, ['workspace']).targets).toEqual([])
  })
  test('unknown name throws exit 2', () => {
    expect(() => selectTargets(config, ['nope'])).toThrow(/Unknown target/)
  })
})

describe('targetCommands', () => {
  test('false disables a verb', () => {
    const c = configSchema.parse({
      name: 'x',
      targets: { a: { kind: 'vite', dir: 'apps/api', test: false } },
    })
    expect(targetCommands(root, c, 'a', 'test')).toBeUndefined()
  })
  test('script defaults are skipped when the script is missing', () => {
    expect(targetCommands(root, config, 'web', 'test')).toBeUndefined()
  })
  test('worker deploy passes --env and sets KIT_ENV', () => {
    const c = configSchema.parse({
      name: 'x',
      targets: { a: { kind: 'worker', dir: 'apps/api', envs: ['s'] } },
    })
    const [cmd] = targetCommands(root, c, 'a', 'deploy', { env: 's' })!
    expect(cmd!.cmd).toEqual(['bun', 'x', 'wrangler', 'deploy', '--env', 's'])
    expect(cmd!.env).toEqual({ KIT_ENV: 's' })
  })
  test('deploy object form: run + before', () => {
    const c = configSchema.parse({
      name: 'x',
      targets: { a: { kind: 'custom', dir: '.', deploy: { run: 'ship it', before: ['env sync'] } } },
    })
    expect(targetCommands(root, c, 'a', 'deploy')![0]!.cmd).toEqual(['sh', '-c', 'ship it'])
  })
})

describe('planVerbs', () => {
  test('staged: only targets with staged files; workspace gets the files', () => {
    const groups = planVerbs(root, config, ['lint'], { staged: ['apps/web/src/a.astro'] })
    expect(groups.map((g) => g.title)).toEqual(['workspace', 'web'])
    expect(groups[0]!.commands.at(-1)!.cmd).toEqual([
      'sh',
      '-c',
      'biome check . "$@"',
      'sh',
      'apps/web/src/a.astro',
    ])
  })
  test('staged with nothing staged plans nothing', () => {
    expect(planVerbs(root, config, ['lint'], { staged: [] })).toEqual([])
  })
})

describe('config', () => {
  test('d1 target must exist', () => {
    const r = configSchema.safeParse({ name: 'x', cloudflare: { d1: { db: { name: 'd', target: 'nope' } } } })
    expect(r.success).toBe(false)
  })
  test('"workspace" is reserved', () => {
    expect(
      configSchema.safeParse({ name: 'x', targets: { workspace: { kind: 'custom', dir: '.' } } }).success,
    ).toBe(false)
  })
})
