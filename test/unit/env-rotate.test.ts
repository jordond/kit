import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { configSchema, type KitConfig } from '../../src/config/schema'
import { assertSelection, pushCommand } from '../../src/lib/env/push-run'
import { destinationsFor, generateValue, pushSelections, rewriteKey } from '../../src/lib/env/rotate'
import { describeSchema } from '../../src/lib/env/schema'
import { KitError } from '../../src/lib/errors'
import { redact, resetSecrets } from '../../src/lib/secrets'

afterEach(() => resetSecrets())

describe('rewriteKey', () => {
  test('replaces only that line; comments, order and other keys stay', () => {
    const text = '# top\nA=1\n\n# about B\nB=old\nC=3\n'
    expect(rewriteKey(text, 'B', 'new')).toBe('# top\nA=1\n\n# about B\nB=new\nC=3\n')
  })

  test('keeps the quote style, export and spacing', () => {
    expect(rewriteKey('A="old"\n', 'A', 'new')).toBe('A="new"\n')
    expect(rewriteKey("A='old'\n", 'A', 'new')).toBe("A='new'\n")
    expect(rewriteKey('export A = old  \nB=2\n', 'A', 'new')).toBe('export A = new  \nB=2\n')
    expect(rewriteKey('A=\n', 'A', 'new')).toBe('A=new\n')
    expect(rewriteKey('A="\n', 'A', 'new')).toBe('A=new\n')
  })

  test('a missing key is appended as its own line; a commented one is not the key', () => {
    expect(rewriteKey('A=1\n', 'B', 'new')).toBe('A=1\nB=new\n')
    expect(rewriteKey('A=1', 'B', 'new')).toBe('A=1\nB=new\n')
    expect(rewriteKey('', 'B', 'new')).toBe('B=new\n')
    expect(rewriteKey('# B=old\n', 'B', 'new')).toBe('# B=old\nB=new\n')
  })

  test('a longer key with the same prefix or suffix is left alone', () => {
    expect(rewriteKey('A_B=1\nX_A=2\nA=3\n', 'A', 'new')).toBe('A_B=1\nX_A=2\nA=new\n')
  })

  test('CRLF files stay CRLF, for a replaced and an appended line', () => {
    expect(rewriteKey('A=1\r\nB="old"\r\nC=3\r\n', 'B', 'new')).toBe('A=1\r\nB="new"\r\nC=3\r\n')
    expect(rewriteKey('A=1\r\n', 'B', 'new')).toBe('A=1\r\nB=new\r\n')
    expect(rewriteKey('A=1\r\nB=2', 'C', 'new')).toBe('A=1\r\nB=2\r\nC=new\r\n')
  })
})

describe('generateValue', () => {
  test('hex: two characters per byte, default 32 bytes', () => {
    expect(generateValue({ kind: 'hex', length: 32 })).toMatch(/^[0-9a-f]{64}$/)
    expect(generateValue({ kind: 'hex', length: 8 })).toMatch(/^[0-9a-f]{16}$/)
  })

  test('base64url: unpadded url-safe alphabet that decodes to `length` bytes', () => {
    const v = generateValue({ kind: 'base64url', length: 32 })
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(v, 'base64url')).toHaveLength(32)
    expect(Buffer.from(generateValue({ kind: 'base64url', length: 48 }), 'base64url')).toHaveLength(48)
  })

  test('uuid ignores length', () => {
    expect(generateValue({ kind: 'uuid', length: 4 })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test('values differ and are registered for redaction', () => {
    const a = generateValue({ kind: 'hex', length: 32 })
    const b = generateValue({ kind: 'hex', length: 32 })
    expect(a).not.toBe(b)
    expect(redact(`put ${a} failed`)).toBe('put *** failed')
  })
})

describe('generate meta', () => {
  const schema = describeSchema(
    z.object({
      HEX: z.string().min(32).meta({ generate: 'hex' }),
      SHORT: z.string().meta({ generate: 'base64url', length: 16 }),
      ID: z.uuid().meta({ generate: 'uuid' }).optional(),
      THIRD_PARTY: z.string(),
      TOO_STRICT: z.string().max(8, 'at most 8 characters').meta({ generate: 'hex' }),
    }),
  )
  const key = (name: string) => schema.keys.find((k) => k.name === name)

  test('generate and length are read, length defaults to 32 bytes, through wrappers too', () => {
    expect(key('HEX')?.generate).toEqual({ kind: 'hex', length: 32 })
    expect(key('SHORT')?.generate).toEqual({ kind: 'base64url', length: 16 })
    expect(key('ID')?.generate).toEqual({ kind: 'uuid', length: 32 })
    expect(key('THIRD_PARTY')?.generate).toBeUndefined()
  })

  test('an unknown generate or a bad length is a config error naming the key', () => {
    expect(() => describeSchema(z.object({ K: z.string().meta({ generate: 'rot13' }) }))).toThrow(
      /K has an unknown generate "rot13"/,
    )
    for (const length of [0, 1.5, '32', 5000]) {
      expect(() => describeSchema(z.object({ K: z.string().meta({ generate: 'hex', length }) }))).toThrow(
        /K has an invalid generate length/,
      )
    }
  })

  test('validateKey checks one value against its own rule and never echoes it', () => {
    const value = generateValue({ kind: 'hex', length: 32 })
    expect(schema.validateKey('HEX', value)).toBeUndefined()
    expect(schema.validateKey('ID', generateValue({ kind: 'uuid', length: 32 }))).toBeUndefined()
    const problem = schema.validateKey('TOO_STRICT', value)
    expect(problem).toBe('at most 8 characters')
    expect(problem).not.toContain(value)
  })
})

describe('where a rotated key goes', () => {
  const make = (env: Record<string, unknown>): KitConfig =>
    configSchema.parse({
      name: 'T',
      env,
      targets: {
        edge: { kind: 'worker', dir: 'edge' },
        admin: { kind: 'worker', dir: 'admin' },
        jobs: { kind: 'worker', dir: 'jobs' },
      },
    })
  const config = make({
    workerSecrets: {
      edge: ['SHARED', 'EDGE_ONLY', 'PAIR'],
      admin: ['SHARED', 'BOTH', 'PAIR'],
      jobs: ['SHARED'],
    },
    githubSecrets: ['BOTH', 'CI_ONLY'],
  })
  const commands = (c: KitConfig, keys: string[]) => pushSelections(c, keys).map(pushCommand)

  test('destinationsFor lists workers in config order, then github', () => {
    expect(destinationsFor(config, 'SHARED')).toEqual(['edge', 'admin', 'jobs'])
    expect(destinationsFor(config, 'BOTH')).toEqual(['admin', 'github'])
    expect(destinationsFor(config, 'LOCAL')).toEqual([])
  })

  test('the push command reaches every holder and no remote that holds none', () => {
    expect(commands(config, ['LOCAL'])).toEqual([])
    expect(commands(config, ['CI_ONLY'])).toEqual(['kit env push --github'])
    expect(commands(config, ['EDGE_ONLY'])).toEqual(['kit env push --target edge'])
    expect(commands(config, ['BOTH'])).toEqual(['kit env push --target admin --github'])
    expect(commands(config, ['SHARED'])).toEqual(['kit env push --workers'])
    expect(commands(config, ['SHARED', 'CI_ONLY'])).toEqual(['kit env push'])
    expect(commands(config, ['PAIR'])).toEqual(['kit env push --target edge', 'kit env push --target admin'])
    expect(commands(config, ['PAIR', 'CI_ONLY'])).toEqual([
      'kit env push --target edge',
      'kit env push --target admin',
      'kit env push --github',
    ])
  })

  test('every worker with no env.githubSecrets configured is a bare push', () => {
    expect(commands(make({ workerSecrets: { edge: ['K'], admin: ['K'] } }), ['K'])).toEqual(['kit env push'])
  })
})

describe('push selection', () => {
  test('--workers is exclusive with --all, --target and --github; --all with --target too', () => {
    for (const sel of [
      { workers: true, all: true },
      { workers: true, target: 'edge' },
      { workers: true, github: true },
      { all: true, target: 'edge' },
    ]) {
      let err: unknown
      try {
        assertSelection(sel)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(KitError)
      expect((err as KitError).exitCode).toBe(2)
      expect((err as KitError).message).toContain('are exclusive')
    }
    expect(() => assertSelection({ workers: true })).not.toThrow()
    expect(() => assertSelection({ target: 'edge', github: true })).not.toThrow()
  })
})
