import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { configSchema, type KitConfig } from '../../src/config/schema'
import { applyInit, planInit, setKey } from '../../src/lib/env/init'
import { type Destination, executePush, GITHUB, type ListResult, planPush } from '../../src/lib/env/push'
import {
  checkOutputs,
  diffKeys,
  GENERATED_BANNER,
  outputs,
  parseDotenv,
  render,
  writeOutputs,
} from '../../src/lib/env/render'
import { describeSchema, implicitSchema } from '../../src/lib/env/schema'
import { redact, resetSecrets } from '../../src/lib/secrets'

afterEach(() => resetSecrets())

const schema = describeSchema(
  z.object({
    INTERNAL_ADMIN_SECRET: z.string().min(32, 'must be at least 32 characters'),
    PUBLIC_BASE_URL: z.url('must be a valid URL').meta({ secret: false, description: 'edge URL' }),
    CAP: z.string().regex(/^\d+$/, 'must be numeric').default('0').meta({ secret: false }),
    OPTIONAL_KEY: z.string().meta({ description: 'dormant' }).optional(),
    ARCHIVE: z.enum(['true', 'false']).default('false'),
  }),
)

const VALID = { INTERNAL_ADMIN_SECRET: 'a'.repeat(32), PUBLIC_BASE_URL: 'https://edge.example.com' }

const config: KitConfig = configSchema.parse({
  name: 'T',
  env: {
    outputs: {
      'edge/.dev.vars': { pick: ['INTERNAL_ADMIN_SECRET', 'PUBLIC_BASE_URL', 'CAP', 'OPTIONAL_KEY'] },
      'admin/.dev.vars': { rename: { X_INTERNAL_SECRET: 'INTERNAL_ADMIN_SECRET' } },
      'all/.dev.vars': {},
    },
    workerSecrets: { edge: ['INTERNAL_ADMIN_SECRET'] },
    githubSecrets: ['DEPLOY_TOKEN'],
  },
  targets: { edge: { kind: 'worker', dir: 'edge' } },
})

let dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kit-env-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('describeSchema', () => {
  test('reads secret, required and description from meta through wrappers', () => {
    expect(schema.keys).toEqual([
      { name: 'INTERNAL_ADMIN_SECRET', secret: true, required: true },
      { name: 'PUBLIC_BASE_URL', secret: false, required: true, description: 'edge URL' },
      { name: 'CAP', secret: false, required: false },
      { name: 'OPTIONAL_KEY', secret: true, required: false, description: 'dormant' },
      { name: 'ARCHIVE', secret: true, required: false },
    ])
  })

  test('reads .describe() as the description', () => {
    expect(describeSchema(z.object({ A: z.string().describe('hi') })).keys[0]?.description).toBe('hi')
  })

  test('rejects a non-object', () => {
    expect(() => describeSchema(z.string())).toThrow(expect.objectContaining({ exitCode: 3 }))
  })
})

describe('validate', () => {
  test('valid env applies defaults and keeps passthrough keys', () => {
    const { values, issues } = schema.validate({ ...VALID, EXTRA: 'x' })
    expect(issues).toEqual([])
    expect(values.CAP).toBe('0')
    expect(values.ARCHIVE).toBe('false')
    expect(values.EXTRA).toBe('x')
  })

  test.each([
    [{ INTERNAL_ADMIN_SECRET: '' }, 'INTERNAL_ADMIN_SECRET'],
    [{ INTERNAL_ADMIN_SECRET: 'short' }, 'INTERNAL_ADMIN_SECRET'],
    [{ PUBLIC_BASE_URL: 'not a url' }, 'PUBLIC_BASE_URL'],
    [{ CAP: 'fifty' }, 'CAP'],
    [{ ARCHIVE: 'yes' }, 'ARCHIVE'],
  ])('rejects %p', (override, key) => {
    const { issues } = schema.validate({ ...VALID, ...override })
    expect(issues.map((i) => i.key)).toContain(key)
  })

  test('registers secret values for redaction, not plain ones', () => {
    schema.validate(VALID)
    expect(redact(`x ${VALID.INTERNAL_ADMIN_SECRET} ${VALID.PUBLIC_BASE_URL}`)).toBe(
      `x *** ${VALID.PUBLIC_BASE_URL}`,
    )
  })

  test('implicit schema: referenced keys, optional, secret', () => {
    const s = implicitSchema(config)
    expect(s.keys.map((k) => k.name)).toEqual([
      'INTERNAL_ADMIN_SECRET',
      'PUBLIC_BASE_URL',
      'CAP',
      'OPTIONAL_KEY',
      'DEPLOY_TOKEN',
    ])
    expect(s.validate({}).issues).toEqual([])
  })
})

describe('render', () => {
  const [edge, admin, all] = outputs(config, schema)
  const { values } = schema.validate({ ...VALID, OTHER: 'nope' })

  test('pick: banner, picked keys, blank as a commented placeholder', () => {
    const out = render(edge!, values)
    expect(out.startsWith(GENERATED_BANNER)).toBe(true)
    expect(out).toContain(`INTERNAL_ADMIN_SECRET=${'a'.repeat(32)}\n`)
    expect(out).toContain('CAP=0\n')
    expect(out).toContain('# OPTIONAL_KEY=\n')
    expect(out).not.toContain('OTHER')
    expect(out.endsWith('\n')).toBe(true)
  })

  test('rename binds a source key under another name, and nothing else', () => {
    const out = render(admin!, values)
    expect(out).toContain(`X_INTERNAL_SECRET=${'a'.repeat(32)}\n`)
    expect(out).not.toContain('INTERNAL_ADMIN_SECRET=')
    expect(out).not.toContain('PUBLIC_BASE_URL')
  })

  test('neither: every schema key', () => {
    expect(all!.lines.map((l) => l.name)).toEqual(schema.keys.map((k) => k.name))
  })

  test('vars: static local-only lines first, written as-is even when empty, never read from .env', () => {
    const c = configSchema.parse({
      name: 'T',
      env: { outputs: { 'a/.dev.vars': { vars: { ENVIRONMENT: 'dev', AUD: '' }, pick: ['CAP'] } } },
    })
    const [o] = outputs(c, schema)
    const out = render(o!, { ...values, ENVIRONMENT: 'prod' })
    expect(out).toBe(`${GENERATED_BANNER}ENVIRONMENT=dev\nAUD=\nCAP=0\n`)
  })

  test('multi-line values are quoted so dotenv keeps every line', () => {
    expect(render({ path: 'x', lines: [{ name: 'PEM', source: 'PEM' }] }, { PEM: 'a\nb' })).toContain(
      'PEM="a\\nb"\n',
    )
  })
})

describe('diffKeys / parseDotenv', () => {
  test('names added, updated and removed', () => {
    expect(diffKeys('A=1\nB=2\n# C=\n', 'A=1\nB=3\nD=4\n')).toEqual({
      added: ['D'],
      updated: ['B'],
      removed: ['C'],
    })
    expect(parseDotenv('export A="q"\n# comment\n# B=\n')).toEqual({ A: 'q', B: '' })
  })
})

describe('writeOutputs / checkOutputs', () => {
  const list = outputs(config, schema).slice(0, 2)
  const values = schema.validate(VALID).values

  test('writes absent files at 0600, then is idempotent', () => {
    const root = tmp()
    const first = writeOutputs(root, list, values)
    expect(first.every((r) => r.changed)).toBe(true)
    expect(first[0]?.added).toContain('INTERNAL_ADMIN_SECRET')
    expect(statSync(join(root, 'edge/.dev.vars')).mode & 0o777).toBe(0o600)
    expect(writeOutputs(root, list, values).every((r) => !r.changed)).toBe(true)
  })

  test('rewrites when content differs and names the changed key', () => {
    const root = tmp()
    writeOutputs(root, list, values)
    const next = schema.validate({ ...VALID, PUBLIC_BASE_URL: 'https://other.example.com' }).values
    const r = writeOutputs(root, list, next)
    expect(r[0]).toMatchObject({ changed: true, updated: ['PUBLIC_BASE_URL'] })
    expect(readFileSync(join(root, 'edge/.dev.vars'), 'utf8')).toContain('https://other.example.com')
  })

  test('dry run writes nothing', () => {
    const root = tmp()
    expect(writeOutputs(root, list, values, true).every((r) => r.changed)).toBe(true)
    expect(existsSync(join(root, 'edge/.dev.vars'))).toBe(false)
  })

  test('check: missing, stale, then clean', () => {
    const root = tmp()
    expect(checkOutputs(root, list, values).map((d) => d.reason)).toEqual(['missing', 'missing'])
    writeOutputs(root, list, values)
    writeFileSync(join(root, 'edge/.dev.vars'), 'tampered\n')
    expect(checkOutputs(root, list, values)).toEqual([
      expect.objectContaining({ path: 'edge/.dev.vars', reason: 'stale' }),
    ])
    writeOutputs(root, list, values)
    expect(checkOutputs(root, list, values)).toEqual([])
  })
})

describe('push', () => {
  const KEY = 'CLOUDFLARE_API_TOKEN'

  function dest(
    opts: { list?: ListResult; fail?: string; keys?: string[] } = {},
  ): Destination & { pushed: [string, string][] } {
    const pushed: [string, string][] = []
    return {
      name: GITHUB,
      keys: opts.keys ?? [KEY],
      pushed,
      list: async () => opts.list ?? { ok: true, names: [] },
      put: async (key, value) => {
        pushed.push([key, value])
        return key === opts.fail ? { code: 1, output: 'boom' } : { code: 0, output: '' }
      },
    }
  }

  test('pushes a new secret', async () => {
    const d = dest()
    const plan = await planPush(d, { [KEY]: 'v' })
    expect(plan.items).toEqual([{ key: KEY, status: 'new' }])
    expect(await executePush([plan], { [KEY]: 'v' })).toEqual([
      { destination: GITHUB, key: KEY, status: 'pushed' },
    ])
    expect(d.pushed).toEqual([[KEY, 'v']])
  })

  test('skips a key that is empty in .env', async () => {
    const d = dest()
    const out = await executePush([await planPush(d, { [KEY]: '' })], { [KEY]: '' })
    expect(d.pushed).toEqual([])
    expect(out[0]?.status).toBe('skipped-empty')
  })

  test('marks an already-set secret as an overwrite', async () => {
    const plan = await planPush(dest({ list: { ok: true, names: [KEY] } }), { [KEY]: 'v' })
    expect(plan.items[0]?.status).toBe('overwrite')
  })

  test('list failure: every key list-failed and nothing pushed, unless proceeding', async () => {
    const list = { ok: false, names: [], error: 'gh: not authenticated' }
    const d = dest({ list })
    const plan = await planPush(d, { [KEY]: 'v' })
    expect(plan.listError).toBe('gh: not authenticated')
    expect(plan.items.every((i) => i.status === 'list-failed')).toBe(true)
    await executePush([plan], { [KEY]: 'v' })
    expect(d.pushed).toEqual([])

    const forced = await planPush(d, { [KEY]: 'v' }, { proceedOnListFailure: true })
    expect(forced.items[0]?.status).toBe('unknown')
    expect((await executePush([forced], { [KEY]: 'v' }))[0]?.status).toBe('pushed')
  })

  test('stops at the first failure with redacted output; later keys are not run', async () => {
    const values = { A: 'value-a', B: 'value-b' }
    const d = dest({ keys: ['A', 'B'], fail: 'A' })
    const out = await executePush([await planPush(d, values)], values)
    expect(out).toEqual([
      { destination: GITHUB, key: 'A', status: 'failed', output: 'boom' },
      { destination: GITHUB, key: 'B', status: 'not-run' },
    ])
    expect(d.pushed.map(([k]) => k)).toEqual(['A'])
  })
})

describe('init', () => {
  test('setKey replaces in place, keeps comments, appends new keys', () => {
    expect(setKey('# c\nA=1\nB=2\n', 'A', 'x')).toBe('# c\nA=x\nB=2\n')
    expect(setKey('A=1\n', 'C', '3')).toBe('A=1\nC=3\n')
    expect(setKey('# A=old\n', 'A', 'n')).toBe('# A=old\nA=n\n')
  })

  test('creates .env from the example and asks for required keys that are empty or placeholders', () => {
    const root = tmp()
    writeFileSync(join(root, '.env.example'), 'INTERNAL_ADMIN_SECRET=replace-me\nPUBLIC_BASE_URL=\n')
    const plan = planInit(root, schema)
    expect(plan.created).toBe(true)
    expect(plan.ask.map((k) => k.name)).toEqual(['INTERNAL_ADMIN_SECRET', 'PUBLIC_BASE_URL'])
    const parsed = applyInit(root, plan, {
      INTERNAL_ADMIN_SECRET: 's'.repeat(32),
      PUBLIC_BASE_URL: 'https://x.y',
    })
    expect(parsed.INTERNAL_ADMIN_SECRET).toBe('s'.repeat(32))
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600)
    expect(planInit(root, schema).ask).toEqual([])
  })

  test('backfills keys the example gained, never asks for optional keys', () => {
    const root = tmp()
    writeFileSync(join(root, '.env.example'), 'INTERNAL_ADMIN_SECRET=\nOPTIONAL_KEY=\nNEW_KEY=default\n')
    writeFileSync(
      join(root, '.env'),
      `INTERNAL_ADMIN_SECRET=${'a'.repeat(32)}\nPUBLIC_BASE_URL=https://x.y\n`,
    )
    const plan = planInit(root, schema)
    expect(plan.created).toBe(false)
    expect(plan.backfilled).toEqual(['OPTIONAL_KEY', 'NEW_KEY'])
    expect(plan.ask).toEqual([])
    expect(applyInit(root, plan, {}).NEW_KEY).toBe('default')
  })
})
