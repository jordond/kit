import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { backupFile, type D1Database, d1Args, d1Tables, seedFile } from '../../src/lib/cloudflare'
import {
  dashboardUrl,
  listArgs,
  localD1Files,
  localD1Hash,
  localD1Id,
  parsePr,
  parseVersionUpload,
  pickRollback,
  previewAlias,
  previewComment,
  previewMarker,
  readWranglerConfig,
  requireWorker,
  rollbackArgs,
  serviceDeployTarget,
  tailArgs,
  versionsUploadArgs,
  workerName,
  workerTargets,
} from '../../src/lib/worker'

const root = resolve(import.meta.dir, '../fixtures/infra')
const config = configSchema.parse({
  ...(await import(`${root}/kit.config.ts`)).default,
  targets: {
    edge: { kind: 'worker', dir: 'apps/edge' },
    site: { kind: 'astro', dir: 'apps/site' },
  },
  cloudflare: undefined,
})
const db: D1Database = { key: 'db', name: 'infra-db', target: 'edge' }

describe('worker targets', () => {
  test('requireWorker: usage errors name the worker targets', () => {
    expect(workerTargets(config)).toEqual(['edge'])
    expect(requireWorker(config, 'edge', 'kit logs').dir).toBe('apps/edge')
    for (const name of [undefined, 'nope', 'site']) {
      expect(() => requireWorker(config, name, 'kit logs')).toThrow(
        expect.objectContaining({ exitCode: 2, hint: 'Worker targets: edge' }),
      )
    }
  })

  test('readWranglerConfig parses JSONC and TOML; none → undefined', () => {
    expect(readWranglerConfig(join(root, 'apps/edge'))?.data.name).toBe('edge')
    expect(readWranglerConfig(join(root, 'apps/analytics'))?.data.name).toBe('analytics')
    expect(readWranglerConfig(join(root, 'apps/admin'))).toBeUndefined()
  })

  test('workerName: an env has its own name, else <name>-<env>', () => {
    const data = { name: 'api', env: { prod: { name: 'api-live' }, staging: {} } }
    expect(workerName(data)).toBe('api')
    expect(workerName(data, 'prod')).toBe('api-live')
    expect(workerName(data, 'staging')).toBe('api-staging')
    expect(workerName({}, 'staging')).toBeUndefined()
  })

  test('dashboardUrl', () => {
    expect(dashboardUrl('abc', 'api')).toBe(
      'https://dash.cloudflare.com/abc/workers/services/view/api/production',
    )
    expect(dashboardUrl(undefined, 'api')).toBe(
      'https://dash.cloudflare.com/?to=/:account/workers/services/view/api/production',
    )
  })
})

describe('preview', () => {
  test('previewAlias sanitises the branch like wrangler', () => {
    expect(previewAlias('feat/Add_Thing', 'api')).toBe('feat-add-thing')
    expect(previewAlias('--fix--x--', 'api')).toBe('fix-x')
    expect(previewAlias('HEAD', 'api')).toBeUndefined()
    expect(previewAlias(undefined, 'api')).toBeUndefined()
    expect(previewAlias('123-fix', 'api')).toBeUndefined()
  })

  test('previewAlias keeps <alias>-<worker> inside a DNS label', () => {
    const alias = previewAlias(`feat/${'x'.repeat(80)}`, 'api-worker')!
    expect(`${alias}-api-worker`.length).toBeLessThanOrEqual(63)
    expect(alias).toMatch(/^feat-x+-[0-9a-f]{4}$/)
    expect(previewAlias('feature', 'w'.repeat(60))).toBeUndefined()
  })

  test('versionsUploadArgs', () => {
    expect(versionsUploadArgs()).toEqual(['versions', 'upload'])
    expect(versionsUploadArgs({ env: 'staging', alias: 'feat-x', extra: ['--tag', 't'] })).toEqual([
      'versions',
      'upload',
      '--env',
      'staging',
      '--preview-alias',
      'feat-x',
      '--tag',
      't',
    ])
  })

  test('parseVersionUpload prefers the alias URL', () => {
    const out = [
      'Uploaded api (2.10 sec)',
      '\x1b[1mWorker Version ID:\x1b[0m 1111-2222',
      'Version Preview URL: https://1111-api.acme.workers.dev',
    ]
    expect(parseVersionUpload(out.join('\n'))).toEqual({
      version: '1111-2222',
      url: 'https://1111-api.acme.workers.dev',
    })
    expect(
      parseVersionUpload(
        [...out, 'Version Preview Alias URL: https://feat-x-api.acme.workers.dev'].join('\n'),
      ).url,
    ).toBe('https://feat-x-api.acme.workers.dev')
    expect(parseVersionUpload('Uploaded api')).toEqual({ version: undefined, url: undefined })
  })

  test('parsePr finds the PR and only its own marked comment for this target', () => {
    const at = (n: number) => `https://github.com/o/r/pull/7#issuecomment-${n}`
    const mine = (target: string, n: number) => ({
      body: previewComment({ target, url: 'u' }),
      url: at(n),
      viewerDidAuthor: true,
    })
    const pr = { number: 7, comments: [{ body: 'hello', url: at(1) }, mine('web', 2), mine('api', 3)] }
    expect(parsePr(JSON.stringify(pr), 'api')).toEqual({ number: 7, commentId: '3' })
    expect(parsePr(JSON.stringify(pr), 'admin')).toEqual({ number: 7 })
    expect(parsePr('no pull requests found', 'api')).toBeUndefined()
    // Someone else's comment with the marker, and the viewer quoting it mid-comment: neither is kit's.
    const human = {
      number: 7,
      comments: [
        { ...mine('api', 4), viewerDidAuthor: false },
        { body: previewComment({ target: 'api', url: 'u' }), url: at(5) },
        { body: `look: ${previewMarker('api')}`, url: at(6), viewerDidAuthor: true },
      ],
    }
    expect(parsePr(JSON.stringify(human), 'api')).toEqual({ number: 7 })
    expect(previewComment({ target: 'api', url: 'https://x', version: 'v1', env: 'staging' })).toBe(
      `${previewMarker('api')}\nPreview of \`api\` (staging): https://x\n\nVersion \`v1\``,
    )
  })
})

describe('rollback and tail', () => {
  test('rollbackArgs: always an explicit version, no --yes (wrangler never reads it)', () => {
    expect(rollbackArgs({ to: 'v1', message: 'm' })).toEqual(['rollback', 'v1', '--message', 'm'])
    expect(rollbackArgs({ to: 'v1', env: 'prod', message: 'm' })).toEqual([
      'rollback',
      'v1',
      '--env',
      'prod',
      '--message',
      'm',
    ])
    expect(listArgs('deployments')).toEqual(['deployments', 'list', '--json'])
    expect(listArgs('versions', 'prod')).toEqual(['versions', 'list', '--env', 'prod', '--json'])
  })

  describe('pickRollback', () => {
    const dep = (version: string, day: number, by?: string) => ({
      created_on: `2026-03-0${day}T10:00:00.000Z`,
      annotations: by ? { 'workers/triggered_by': by } : {},
      versions: [{ version_id: version, percentage: 100 }],
    })
    const pick = (deployments: unknown[], versions: unknown[] = []) =>
      pickRollback(JSON.stringify(deployments), JSON.stringify(versions))

    test('the previous deployment when it is other code', () => {
      expect(pick([dep('b', 2), dep('a', 1)])).toEqual({
        version: 'a',
        deployed: '2026-03-01T10:00:00.000Z',
        secretChanges: 0,
      })
    })

    test('secret-only deployments on top are skipped, whichever listing marks them', () => {
      const versions = [{ id: 's2', annotations: { 'workers/triggered_by': 'secret' } }]
      expect(pick([dep('a', 1), dep('b', 2), dep('s1', 3, 'secret'), dep('s2', 4)], versions)).toEqual({
        version: 'a',
        deployed: '2026-03-01T10:00:00.000Z',
        secretChanges: 2,
      })
    })

    test('a secret push on the older code is the version to go back to (its secrets are the newest)', () => {
      expect(pick([dep('a', 1), dep('a-secret', 2, 'secret'), dep('b', 3)])?.version).toBe('a-secret')
    })

    test('an earlier rollback to the live code is not a different code version', () => {
      // a, b, then rolled back to a: live is a; the last different code is b.
      expect(pick([dep('a', 1), dep('b', 2), dep('a', 3, 'rollback')])?.version).toBe('b')
    })

    test('gradual deployments without a 100% version are ignored', () => {
      const split = {
        created_on: '2026-03-02T10:00:00.000Z',
        versions: [{ version_id: 'x', percentage: 50 }],
      }
      expect(pick([dep('a', 1), split, dep('b', 3)])?.version).toBe('a')
    })

    test('nothing to go back to, or not a listing: undefined', () => {
      expect(pick([dep('b', 1), dep('s', 2, 'secret')])).toBeUndefined()
      expect(pick([dep('b', 1)])).toBeUndefined()
      expect(pick([])).toBeUndefined()
      expect(pickRollback('Authentication error')).toBeUndefined()
      expect(pickRollback('{}')).toBeUndefined()
    })
  })

  test('tailArgs', () => {
    expect(tailArgs()).toEqual(['tail'])
    expect(tailArgs({ env: 'prod', extra: ['--status', 'error'] })).toEqual([
      'tail',
      '--env',
      'prod',
      '--status',
      'error',
    ])
  })

  test('serviceDeployTarget reads `kit deploy <target>`', () => {
    expect(serviceDeployTarget('kit deploy api')).toEqual({ target: 'api', env: undefined })
    expect(serviceDeployTarget(' kit deploy worker --env prod ')).toEqual({ target: 'worker', env: 'prod' })
    expect(serviceDeployTarget('kit deploy -e prod api --yes')).toEqual({ target: 'api', env: 'prod' })
    expect(serviceDeployTarget('kit deploy api --env=prod -- --minify')).toEqual({
      target: 'api',
      env: 'prod',
    })
    expect(serviceDeployTarget('kit deploy api web')).toBeUndefined()
    expect(serviceDeployTarget('kit build api')).toBeUndefined()
    expect(serviceDeployTarget('./deploy.sh api')).toBeUndefined()
  })
})

describe('d1', () => {
  test('d1Tables: user tables from d1 execute --json, or undefined', () => {
    const out = (names: string[]) =>
      JSON.stringify([{ results: names.map((name) => ({ name })), success: true }])
    expect(d1Tables(out([]))).toEqual([])
    expect(d1Tables(out(['_cf_KV', 'd1_migrations', 'sqlite_sequence', 'users']))).toEqual([
      'd1_migrations',
      'users',
    ])
    expect(d1Tables('Authentication error')).toBeUndefined()
    expect(d1Tables('[{"success":false}]')).toBeUndefined()
    expect(d1Tables('[]')).toBeUndefined()
  })

  test('d1Args export', () => {
    expect(d1Args(db, { kind: 'export', remote: false, output: '/tmp/a.sql' })).toEqual([
      'd1',
      'export',
      'infra-db',
      '--local',
      '--output',
      '/tmp/a.sql',
    ])
    expect(d1Args(db, { kind: 'export', remote: true, output: 'a.sql' })[3]).toBe('--remote')
  })

  test('backupFile: backups/<db>-<UTC timestamp>.sql', () => {
    expect(backupFile('/repo', db, new Date('2026-01-02T03:04:05.678Z'))).toBe(
      '/repo/backups/infra-db-20260102T030405Z.sql',
    )
  })

  test('seedFile: configured and present, else exit 3', () => {
    expect(seedFile(root, { ...db, seed: 'apps/edge/wrangler.jsonc' })).toBe(
      join(root, 'apps/edge/wrangler.jsonc'),
    )
    expect(() => seedFile(root, db)).toThrow(expect.objectContaining({ exitCode: 3 }))
    expect(() => seedFile(root, { ...db, seed: 'nope.sql' })).toThrow(
      expect.objectContaining({ exitCode: 3 }),
    )
  })

  test('the schema takes cloudflare.d1.<db>.seed as a string', () => {
    const base = { name: 'x', targets: { edge: { kind: 'worker', dir: '.' } } }
    const d1 = (seed: unknown) => ({ cloudflare: { d1: { db: { name: 'n', target: 'edge', seed } } } })
    expect(configSchema.parse({ ...base, ...d1('seed.sql') }).cloudflare?.d1?.db?.seed).toBe('seed.sql')
    expect(configSchema.safeParse({ ...base, ...d1(1) }).success).toBe(false)
  })

  test('localD1Id: preview id, then database id, then the binding', () => {
    const data = {
      d1_databases: [
        { binding: 'A', database_name: 'a' },
        { binding: 'B', database_name: 'b', database_id: 'id-b' },
        { binding: 'C', database_name: 'c', database_id: 'id-c', preview_database_id: 'prev-c' },
      ],
    }
    expect(localD1Id(data, 'a')).toBe('A')
    expect(localD1Id(data, 'b')).toBe('id-b')
    expect(localD1Id(data, 'C')).toBe('prev-c')
    expect(localD1Id(data, 'nope')).toBeUndefined()
    expect(localD1Id({}, 'a')).toBeUndefined()
  })

  test('localD1Files: miniflare names the file by an HMAC of the id', () => {
    // Known answer from miniflare's durableObjectNamespaceIdFromName('miniflare-D1DatabaseObject', 'DB').
    expect(localD1Hash('DB')).toBe('e7352547963de7050bd7d94658afc4fe78b61811b7815da12d90be8e863abf4d')
    const [sqlite, shm, wal] = localD1Files('/w', 'DB')
    expect(sqlite).toBe(`/w/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/${localD1Hash('DB')}.sqlite`)
    expect([shm, wal]).toEqual([`${sqlite}-shm`, `${sqlite}-wal`])
  })
})
