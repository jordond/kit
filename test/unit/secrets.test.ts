import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { runCleanup } from '../../src/lib/cleanup'
import {
  decodeSecretFile,
  MASK,
  pipeSecret,
  redact,
  registerSecret,
  resetSecrets,
  secretDir,
  secretFile,
} from '../../src/lib/secrets'

afterEach(() => resetSecrets())

describe('redact', () => {
  test('masks every registered value, longest first', () => {
    registerSecret('abcd1234')
    registerSecret('abcd1234-longer')
    expect(redact('a abcd1234-longer b abcd1234 c')).toBe(`a ${MASK} b ${MASK} c`)
  })

  test('ignores empty and very short values', () => {
    registerSecret('')
    registerSecret(undefined)
    registerSecret('0')
    expect(redact('0 true')).toBe('0 true')
  })

  test('masks each line of a multi-line value on its own', () => {
    registerSecret('-----BEGIN KEY-----\nMIIBsecretline\n-----END KEY-----')
    expect(redact('bad line: MIIBsecretline')).toBe(`bad line: ${MASK}`)
  })
})

describe('secret files', () => {
  test('decodes base64 to a 0600 file in a 0700 per-run dir', () => {
    const path = decodeSecretFile('key.p8', Buffer.from('private-key').toString('base64'))
    expect(readFileSync(path, 'utf8')).toBe('private-key')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    expect(secretFile('other', 'x').startsWith(dirname(path))).toBe(true)
  })

  test('rejects names with a path and base64 that decodes to nothing', () => {
    expect(() => secretFile('../escape', 'x')).toThrow()
    expect(() => decodeSecretFile('empty', '')).toThrow()
  })

  test('cleanup removes the dir', async () => {
    const path = secretFile('token', 'value')
    expect(existsSync(path)).toBe(true)
    await runCleanup()
    expect(existsSync(path)).toBe(false)
    expect(secretDir()).toBeUndefined()
  })
})

describe('pipeSecret', () => {
  test('feeds the value on stdin, not argv', async () => {
    const r = await pipeSecret(['sh', '-c', 'read v; [ "$v" = "the-value" ]'], 'the-value\n')
    expect(r.code).toBe(0)
  })

  test('redacts the value from failure output', async () => {
    const r = await pipeSecret(['sh', '-c', 'cat; echo; exit 3'], 'leaky-value')
    expect(r.code).toBe(3)
    expect(r.output).not.toContain('leaky-value')
    expect(r.output).toContain(MASK)
  })
})
