import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { fastlaneEnv } from '../../src/lib/fastlane'
import { fixture } from '../helpers/fixture'

// The shared Fastfile itself (every other e2e swaps `bundle` for a recorder):
// - test/fastlane/*.rb run its kit_* helpers against stubbed store objects, with plain Ruby and its
//   bundled minitest (kit's Gemfile gains no gem, and minitest cannot load under `bundle exec`);
// - the pinned fastlane parses it and lists the lanes kit calls. Nothing talks to a store.

const KIT = resolve(import.meta.dir, '../..')

const spawn = (cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
  const r = Bun.spawnSync(cmd, {
    cwd: opts.cwd ?? KIT,
    env: { ...process.env, ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` }
}

const hasMinitest = !!Bun.which('ruby') && spawn(['ruby', '-e', 'require "minitest"']).code === 0

/** kit's fastlane bundle is installed (`kit init` does it); CI for kit itself has no Ruby bundle. */
function bundleInstalled(): boolean {
  if (!Bun.which('bundle')) return false
  return spawn(['bundle', 'check'], { env: fastlaneEnv(KIT) }).code === 0
}

describe.skipIf(!hasMinitest)('Fastfile helpers (ruby test/fastlane/run.rb)', () => {
  test('promote build selection, rollout release selection, group resolution', () => {
    const r = spawn(['ruby', join(KIT, 'test/fastlane/run.rb')])
    expect(r.out).toMatch(/\d+ runs, \d+ assertions, 0 failures, 0 errors, 0 skips/)
    expect(r.code).toBe(0)
  })
})

describe.skipIf(!bundleInstalled())('Fastfile under the pinned fastlane', () => {
  test('parses, and defines the lanes kit release status|promote|rollout call', () => {
    const f = fixture('release', [])
    try {
      const appRoot = join(f.dir, 'client')
      const r = spawn(['bundle', 'exec', 'fastlane', 'lanes', '--json'], {
        cwd: appRoot,
        env: { ...fastlaneEnv(appRoot), CI: 'true' },
      })
      expect(r.code).toBe(0)
      const lanes = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)) as Record<
        string,
        Record<string, unknown>
      >
      expect(Object.keys(lanes.ios ?? {})).toEqual(
        expect.arrayContaining([
          'status',
          'promote_build',
          'promote_testflight',
          'promote_appstore',
          'rollout',
        ]),
      )
      expect(Object.keys(lanes.android ?? {})).toEqual(
        expect.arrayContaining(['status', 'promote', 'rollout']),
      )
    } finally {
      f.cleanup()
    }
  })
})
