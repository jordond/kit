import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfigFile, parseConfig } from '../../src/config/load'

describe('parseConfig', () => {
  test('drops unknown keys at any depth and reports their paths', () => {
    const { result, unknown } = parseConfig({
      name: 'app',
      future: true,
      targets: { api: { kind: 'worker', dir: 'apps/api', extra: 1 } },
    })
    expect(result.success).toBe(true)
    expect(unknown.sort()).toEqual(['future', 'targets.api.extra'])
    if (result.success) {
      expect('future' in result.data).toBe(false)
      expect(result.data.targets.api).not.toHaveProperty('extra')
    }
  })

  test('keeps other errors', () => {
    const { result, unknown } = parseConfig({ name: 'app', future: true, targets: { api: { kind: 'nope' } } })
    expect(result.success).toBe(false)
    expect(unknown).toEqual(['future'])
    if (!result.success) expect(result.error.issues.every((i) => i.code !== 'unrecognized_keys')).toBe(true)
  })

  test('does not touch the input', () => {
    const input = { name: 'app', future: true, targets: {} }
    parseConfig(input)
    expect(input.future).toBe(true)
  })
})

describe('loadConfigFile', () => {
  test('warns about unknown keys instead of failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-config-'))
    const file = join(dir, 'kit.config.ts')
    writeFileSync(file, `export default { name: 'app', targets: {}, someday: { x: 1 } }\n`)
    const warnings: string[] = []
    const config = await loadConfigFile(file, 'kit.config.ts', { warn: (m) => warnings.push(m) })
    expect(config.name).toBe('app')
    expect(warnings).toEqual(['kit.config.ts: ignoring unknown key someday'])
  })

  test('still fails on a wrong type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-config-'))
    const file = join(dir, 'kit.config.ts')
    writeFileSync(file, `export default { name: 1, targets: {} }\n`)
    await expect(loadConfigFile(file, 'kit.config.ts', { warn: () => {} })).rejects.toThrow(
      'Invalid kit.config.ts',
    )
  })
})
