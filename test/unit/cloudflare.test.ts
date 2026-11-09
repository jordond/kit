import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configSchema, type KitConfig } from '../../src/config/schema'
import {
  accountTarget,
  d1Args,
  parseSecretNames,
  pinCloudflareAccount,
  readAccountId,
  resolveAccountId,
  resolveD1,
  sqlString,
  wrangler,
} from '../../src/lib/cloudflare'
import { childEnv } from '../../src/lib/proc'

const root = resolve(import.meta.dir, '../fixtures/infra')
const config = configSchema.parse((await import(`${root}/kit.config.ts`)).default)
const EDGE_ID = '0123456789abcdef0123456789abcdef'

const withCloudflare = (cloudflare: KitConfig['cloudflare']): KitConfig => ({ ...config, cloudflare })

describe('readAccountId', () => {
  test('reads jsonc (comments and all) and toml', () => {
    expect(readAccountId(join(root, 'apps/edge')).id).toBe(EDGE_ID)
    expect(readAccountId(join(root, 'apps/analytics')).id).toBe('fedcba9876543210fedcba9876543210')
  })

  test('no wrangler config → nothing; a config without the key → file but no id', () => {
    expect(readAccountId(join(root, 'apps/admin'))).toEqual({})
    const dir = mkdtempSync(join(tmpdir(), 'kit-cf-'))
    writeFileSync(join(dir, 'wrangler.json'), '{ "name": "x" }')
    expect(readAccountId(dir)).toEqual({ file: join(dir, 'wrangler.json'), id: undefined })
  })
})

describe('resolveAccountId', () => {
  test('from-wrangler reads the first d1 entry target', () => {
    expect(accountTarget(config)).toBe('edge')
    expect(resolveAccountId(root, config)).toBe(EDGE_ID)
  })

  test('without d1, the first worker target', () => {
    const c = withCloudflare({ accountId: 'from-wrangler' })
    expect(accountTarget(c)).toBe('edge')
    expect(resolveAccountId(root, c)).toBe(EDGE_ID)
  })

  test('a literal id is used as is; unset → undefined', () => {
    expect(resolveAccountId(root, withCloudflare({ accountId: 'abc' }))).toBe('abc')
    expect(resolveAccountId(root, withCloudflare(undefined))).toBeUndefined()
  })

  test('throws exit 3 rather than guessing when the key is missing', () => {
    const c = withCloudflare({ accountId: 'from-wrangler', d1: { db: { name: 'x', target: 'admin' } } })
    expect(() => resolveAccountId(root, c)).toThrow(expect.objectContaining({ exitCode: 3 }))
  })
})

describe('pinCloudflareAccount', () => {
  // The failure this exists to prevent: an id the shell already exports (from another project)
  // would otherwise reach every spawned wrangler and retarget d1 and secret at that account.
  test('overrides an ambient account id for children', () => {
    const before = process.env.CLOUDFLARE_ACCOUNT_ID
    try {
      process.env.CLOUDFLARE_ACCOUNT_ID = 'deadbeefdeadbeefdeadbeefdeadbeef'
      expect(pinCloudflareAccount(root, config)).toBe(EDGE_ID)
      expect(childEnv().CLOUDFLARE_ACCOUNT_ID).toBe(EDGE_ID)
    } finally {
      if (before === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
      else process.env.CLOUDFLARE_ACCOUNT_ID = before
    }
  })
})

describe('wrangler', () => {
  test('runs from the target dir through its package manager', () => {
    expect(wrangler(root, config, 'edge', 'secret', 'list')).toEqual({
      cmd: ['bun', 'x', 'wrangler', 'secret', 'list'],
      cwd: join(root, 'apps/edge'),
    })
  })
})

describe('parseSecretNames', () => {
  test('reads names, tolerates junk', () => {
    expect(parseSecretNames('[{"name":"A","type":"secret_text"},{"name":""},{}]')).toEqual(['A'])
    expect(parseSecretNames('not json')).toEqual([])
    expect(parseSecretNames('{}')).toEqual([])
  })
})

describe('resolveD1', () => {
  test('several databases and no --db: usage error listing them', () => {
    expect(() => resolveD1(config, undefined)).toThrow(expect.objectContaining({ exitCode: 2 }))
    try {
      resolveD1(config, undefined)
    } catch (e) {
      expect((e as { hint: string }).hint).toBe('Databases: db (infra-db), analytics (infra-analytics)')
    }
  })

  test('picks by key or by name; the only one by default', () => {
    expect(resolveD1(config, 'analytics').name).toBe('infra-analytics')
    expect(resolveD1(config, 'infra-db').key).toBe('db')
    const one = withCloudflare({ d1: { db: { name: 'only', target: 'edge' } } })
    expect(resolveD1(one, undefined).name).toBe('only')
  })

  test('rejects an unknown --db rather than guessing; none configured is exit 3', () => {
    expect(() => resolveD1(config, 'nope')).toThrow(/Unknown D1 database "nope"/)
    expect(() => resolveD1(withCloudflare(undefined), undefined)).toThrow(
      expect.objectContaining({ exitCode: 3 }),
    )
  })
})

describe('d1Args', () => {
  const db = { key: 'analytics', name: 'infra-analytics', target: 'analytics' }
  test('passes the chosen database to migrate, list, create and exec', () => {
    expect(d1Args(db, { kind: 'migrate', remote: false })).toEqual([
      'd1',
      'migrations',
      'apply',
      'infra-analytics',
      '--local',
    ])
    expect(d1Args(db, { kind: 'list', remote: true })).toEqual([
      'd1',
      'migrations',
      'list',
      'infra-analytics',
      '--remote',
    ])
    expect(d1Args(db, { kind: 'create', migration: 'add_events' })).toEqual([
      'd1',
      'migrations',
      'create',
      'infra-analytics',
      'add_events',
    ])
    expect(d1Args(db, { kind: 'exec', remote: false, sql: 'SELECT 1', json: true })).toEqual([
      'd1',
      'execute',
      'infra-analytics',
      '--local',
      '--command',
      'SELECT 1',
      '--json',
    ])
    expect(d1Args(db, { kind: 'exec', remote: true, file: '/x.sql' })).toEqual([
      'd1',
      'execute',
      'infra-analytics',
      '--remote',
      '--file',
      '/x.sql',
    ])
  })
})

test('sqlString doubles embedded quotes', () => {
  expect(sqlString("O'Brien")).toBe("'O''Brien'")
})
