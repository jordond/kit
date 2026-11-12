import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { KitContext } from '../../src/cli/command'
import { configSchema } from '../../src/config/schema'
import { ExitCode, KitError } from '../../src/lib/errors'
import { exportShots } from '../../src/lib/storeshots/command'
import type { ExportOptions } from '../../src/lib/storeshots/types'
import fixtureConfig from '../fixtures/shots-app/kit.config'

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'shots-app')

/** A dry run of `exportShots` on the fixture, called the way a repo command calls it. */
async function exported(opts: Partial<ExportOptions>): Promise<unknown> {
  const ctx = {
    root: FIXTURE,
    config: configSchema.parse(fixtureConfig),
    flags: { dryRun: true, json: true },
  } as unknown as KitContext
  try {
    await exportShots(ctx, { stores: ['apple'], allowMissing: false, force: false, ...opts })
  } catch (e) {
    return e
  }
  return undefined
}

describe('exportShots', () => {
  test('an empty or blank `out` is a usage error, not the repo root or a directory named " "', async () => {
    for (const out of ['', ' ', '\t']) {
      const e = await exported({ out })
      expect(e).toBeInstanceOf(KitError)
      expect((e as KitError).message).toBe('--out has an empty value')
      expect((e as KitError).exitCode).toBe(ExitCode.usage)
    }
    expect(existsSync(join(FIXTURE, 'apple'))).toBe(false)
    expect(existsSync(join(FIXTURE, ' '))).toBe(false)
  })

  test('a blank locale or no store is a usage error', async () => {
    const locale = await exported({ locales: ['en-US', ' '], out: 'build/shots' })
    expect((locale as KitError).message).toBe('--locale has an empty value')
    expect((locale as KitError).exitCode).toBe(ExitCode.usage)
    const stores = await exported({ stores: [], out: 'build/shots' })
    expect((stores as KitError).exitCode).toBe(ExitCode.usage)
  })
})
