import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { builtins } from '../../src/cli/builtins'
import { configSchema, RESERVED_SERVICE_NAMES } from '../../src/config/schema'
import {
  affectedTargets,
  isGradleTask,
  planVerbs,
  selectTargets,
  targetCommands,
  touches,
} from '../../src/lib/targets'

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
  test('a root-dir target is skipped when nothing is staged', () => {
    const c = configSchema.parse({ name: 'x', targets: { root: { kind: 'custom', dir: '.', lint: 'x' } } })
    expect(planVerbs(root, c, ['lint'], { staged: [] })).toEqual([])
    expect(planVerbs(root, c, ['lint'], { staged: ['a.ts'] }).map((g) => g.title)).toEqual(['root'])
  })
  test('staged with nothing staged plans nothing', () => {
    expect(planVerbs(root, config, ['lint'], { staged: [] })).toEqual([])
  })
})

describe('affected', () => {
  const shared = configSchema.parse({
    name: 'x',
    targets: {
      api: { kind: 'worker', dir: 'apps/api', paths: ['packages/shared', 'schema/**/*.sql'] },
      web: { kind: 'astro', dir: 'apps/web', paths: ['./packages/ui/'] },
      client: { kind: 'gradle', dir: 'apps/client' },
    },
  })
  const names = (files: string[], c = shared) => affectedTargets(root, c, files)

  test('a file under a target dir affects that target only', () => {
    expect(names(['apps/web/src/a.astro'])).toEqual(['web'])
    expect(names(['apps/api/src/a.ts', 'apps/client/shared/A.kt'])).toEqual(['api', 'client'])
    // A sibling dir sharing the prefix is not under the target.
    expect(names(['apps/api/a.ts', 'apps/api-old/a.ts'])).toEqual(['api', 'web', 'client'])
  })
  test('paths: a dir, a dir with ./ and a trailing slash, and a glob', () => {
    expect(names(['packages/shared/src/x.ts'])).toEqual(['api'])
    expect(names(['packages/ui/Button.tsx'])).toEqual(['web'])
    expect(names(['schema/v2/0001_init.sql'])).toEqual(['api'])
    expect(names(['schema/v2/readme.md'])).toEqual(['api', 'web', 'client'])
  })
  test('paths: a glob that matches directories owns everything under them', () => {
    const c = configSchema.parse({
      name: 'x',
      targets: {
        api: { kind: 'worker', dir: 'apps/api', paths: ['packages/*', 'libs/shared-*/'] },
        web: { kind: 'astro', dir: 'apps/web', paths: ['design/**'] },
      },
    })
    expect(names(['packages/core/src/deep/x.ts'], c)).toEqual(['api'])
    expect(names(['libs/shared-ui/src/x.ts'], c)).toEqual(['api'])
    expect(names(['design/tokens/a.json'], c)).toEqual(['web'])
    expect(names(['libs/private/x.ts'], c)).toEqual(['api', 'web'])
  })
  test('paths: !entry excludes after the positive entries; alone it adds nothing', () => {
    const c = configSchema.parse({
      name: 'x',
      targets: {
        api: {
          kind: 'worker',
          dir: 'apps/api',
          paths: ['packages/shared', '!packages/shared/docs', '!**/*.md'],
        },
        web: { kind: 'astro', dir: 'apps/web', paths: ['!packages/shared/docs'] },
        ui: { kind: 'vite', dir: 'apps/ui', paths: ['packages/shared/docs'] },
      },
    })
    expect(names(['packages/shared/src/x.ts'], c)).toEqual(['api'])
    expect(names(['packages/shared/docs/guide.txt'], c)).toEqual(['ui'])
    // Claimed by api and excluded: ignored, not unowned, so it fans out to nobody.
    expect(names(['packages/shared/README.md'], c)).toEqual([])
    expect(names(['packages/shared/README.md', 'apps/ui/a.ts'], c)).toEqual(['ui'])
    // Matched by an exclusion only (no positive entry, no dir): still unowned, every target.
    expect(names(['docs/README.md'], c)).toEqual(['api', 'web', 'ui'])
    expect(planVerbs(root, c, ['lint'], { affected: ['packages/shared/README.md'] })).toEqual([])
    // A target with only exclusions does not claim the rest of the repo.
    expect(touches(root, c.targets.web!, ['bun.lock', 'apps/api/a.ts'])).toBe(false)
    // Exclusions never apply to the target's own dir.
    expect(names(['apps/api/README.md'], c)).toEqual(['api'])
  })
  test('a change outside the kit root (../) is unowned: every target', () => {
    expect(names(['../bun.lock'])).toEqual(['api', 'web', 'client'])
    expect(names(['apps/web/a.astro', '../../.github/ci.yml'])).toEqual(['api', 'web', 'client'])
    const c = configSchema.parse({
      name: 'x',
      targets: { root: { kind: 'custom', dir: '.' }, any: { kind: 'vite', dir: 'a', paths: ['**'] } },
    })
    expect(touches(root, c.targets.any!, ['../x.ts'])).toBe(false)
    expect(names(['../x.ts'], c)).toEqual(['root', 'any'])
  })
  test('a file no target owns (lockfile, CI, root config) affects every target', () => {
    expect(names(['bun.lock'])).toEqual(['api', 'web', 'client'])
    expect(names(['.github/workflows/ci.yml'])).toEqual(['api', 'web', 'client'])
    expect(names(['apps/web/a.astro', 'kit.config.ts'])).toEqual(['api', 'web', 'client'])
  })
  test('nothing changed affects nothing', () => {
    expect(names([])).toEqual([])
  })
  test('a target at the repo root is always affected but owns no file', () => {
    const c = configSchema.parse({
      name: 'x',
      targets: { root: { kind: 'custom', dir: '.' }, api: { kind: 'worker', dir: 'apps/api' } },
    })
    expect(names(['apps/api/a.ts'], c)).toEqual(['root', 'api'])
    expect(names(['bun.lock'], c)).toEqual(['root', 'api'])
  })
  test('touches: dir or paths; no files touch nothing', () => {
    const t = shared.targets.api!
    expect(touches(root, t, ['apps/api/a.ts'])).toBe(true)
    expect(touches(root, t, ['packages/shared/x.ts'])).toBe(true)
    expect(touches(root, t, ['packages/other/x.ts'])).toBe(false)
    expect(touches(root, t, [])).toBe(false)
  })
  test('staged: paths select the target too; the file list the tools get is unchanged', () => {
    const c = configSchema.parse({
      name: 'x',
      workspace: { lint: 'biome check' },
      toolchain: { root: 'apps/client' },
      targets: {
        web: { kind: 'astro', dir: 'apps/web', paths: ['packages/ui'] },
        client: { kind: 'kotlin', dir: 'apps/client', paths: ['shared-kt/**'] },
      },
    })
    const groups = planVerbs(root, c, ['lint'], { staged: ['packages/ui/Button.tsx'] })
    expect(groups.map((g) => g.title)).toEqual(['workspace', 'web'])
    expect(groups[0]!.commands[0]!.cmd.slice(-1)).toEqual(['packages/ui/Button.tsx'])
    expect(groups[1]!.commands[0]!.cmd).toEqual(['bun', 'x', 'astro', 'check'])
    // ktlint runs in the toolchain root: a staged file outside it selects the target but is not passed.
    const kt = planVerbs(root, c, ['lint'], { staged: ['shared-kt/A.kt', 'apps/client/B.kt'] })
    expect(kt.find((g) => g.title === 'client')!.commands[0]!.cmd).toEqual(['ktlint', '--relative', 'B.kt'])
    expect(planVerbs(root, c, ['lint'], { staged: ['shared-kt/A.kt'] }).map((g) => g.title)).toEqual([
      'workspace',
    ])
  })
  test('staged: a file no target owns does not fan out to every target', () => {
    expect(planVerbs(root, shared, ['lint'], { staged: ['bun.lock'] }).map((g) => g.title)).toEqual([])
    expect(planVerbs(root, config, ['lint'], { staged: ['bun.lock'] }).map((g) => g.title)).toEqual([
      'workspace',
    ])
  })

  test('planVerbs: only affected targets, workspace whenever anything changed', () => {
    const titles = (affected: string[], targets?: string[]) =>
      planVerbs(root, config, ['lint'], { affected, targets }).map((g) => g.title)
    expect(titles(['apps/web/src/a.astro'])).toEqual(['workspace', 'web'])
    expect(titles(['apps/client/a.kt'])).toEqual(['workspace', 'client'])
    expect(titles(['bun.lock'])).toEqual(['workspace', 'web', 'client'])
    expect(titles([])).toEqual([])
  })
  test('planVerbs: named targets and affected intersect', () => {
    const titles = (affected: string[], targets: string[]) =>
      planVerbs(root, config, ['lint'], { affected, targets }).map((g) => g.title)
    expect(titles(['apps/web/a.astro', 'apps/client/a.kt'], ['client'])).toEqual(['client'])
    expect(titles(['apps/web/a.astro'], ['client'])).toEqual([])
    expect(titles(['apps/client/a.kt'], ['web'])).toEqual(['workspace'])
  })
  test('planVerbs: no file list reaches the tools', () => {
    const [workspace] = planVerbs(root, config, ['lint'], { affected: ['apps/web/a.astro'] })
    expect(workspace!.commands.at(-1)!.cmd).toEqual(['sh', '-c', 'biome check .'])
  })
})

describe('config', () => {
  test('paths is a list of strings', () => {
    const t = { kind: 'worker', dir: 'apps/api' }
    expect(
      configSchema.safeParse({ name: 'x', targets: { a: { ...t, paths: ['packages/x'] } } }).success,
    ).toBe(true)
    expect(configSchema.safeParse({ name: 'x', targets: { a: { ...t, paths: 'packages/x' } } }).success).toBe(
      false,
    )
  })
  test('d1 target must exist', () => {
    const r = configSchema.safeParse({ name: 'x', cloudflare: { d1: { db: { name: 'd', target: 'nope' } } } })
    expect(r.success).toBe(false)
  })
  test('"workspace" is reserved', () => {
    expect(
      configSchema.safeParse({ name: 'x', targets: { workspace: { kind: 'custom', dir: '.' } } }).success,
    ).toBe(false)
  })
  test('a service cannot take the name of a kit release command', () => {
    const svc = { versionKey: 'k', deploy: 'kit deploy api' }
    for (const name of ['ios', 'android', 'certs', 'status', 'promote', 'rollout', 'metadata', 'rollback']) {
      expect(configSchema.safeParse({ name: 'x', release: { services: { [name]: svc } } }).success).toBe(
        false,
      )
    }
    expect(configSchema.safeParse({ name: 'x', release: { services: { api: svc } } }).success).toBe(true)
  })
  test('every `kit release <name>` built-in is a reserved service name', () => {
    const names = new Set(builtins.filter((b) => b.path[0] === 'release').map((b) => b.path[1]))
    expect([...names].sort()).toEqual([...RESERVED_SERVICE_NAMES].sort())
  })
})
