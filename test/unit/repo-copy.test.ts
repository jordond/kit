import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCopy } from '../../src/cli/repo-copy'

const tmp = mkdtempSync(join(tmpdir(), 'repo-copy-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const write = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

/** A repo pinning `^0.7.0`, with `installed` in its node_modules when given. */
function repo(name: string, installed?: string): string {
  const root = join(tmp, name)
  write(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@jordond/kit': '^0.7.0' } }))
  if (installed) {
    const dir = join(root, 'node_modules/@jordond/kit')
    write(join(dir, 'package.json'), JSON.stringify({ name: '@jordond/kit', version: installed }))
    write(join(dir, 'dist/cli.js'), '')
  }
  return root
}

function run(root: string, argv: string[], skip = false, ownVersion = '0.9.0') {
  const lines: string[] = []
  const spawned: string[] = []
  const result = ensureCopy(root, argv, {
    tokens: argv.filter((a) => !a.startsWith('-')),
    own: { dir: join(tmp, 'global'), version: ownVersion },
    skip,
    log: { warn: (m) => lines.push(m), dim: (m) => lines.push(m) },
    spawn: async (cli) => (spawned.push(cli), 0),
  })
  return { result, lines, spawned }
}

describe('ensureCopy', () => {
  test('a stale install warns, then hands off to the repo copy', async () => {
    const { result, lines, spawned } = run(repo('stale', '0.6.0'), ['doctor'])
    expect(await result).toBe(0)
    expect(lines[0]).toContain('installed kit is 0.6.0')
    expect(lines[1]).not.toContain('bun install')
    expect(spawned).toHaveLength(1)
  })

  test('complete and completion stay quiet', async () => {
    for (const cmd of ['complete', 'completion']) {
      expect(run(repo('quiet', '0.6.0'), [cmd]).lines).toEqual([])
      const none = run(repo('quiet-none'), [cmd])
      expect(await none.result).toBeUndefined()
      expect(none.lines).toEqual([])
    }
  })

  test('--json stays quiet', () => {
    expect(run(repo('json', '0.6.0'), ['doctor', '--json']).lines).toEqual([])
  })

  test('the handoff child does not warn again', async () => {
    const { result, lines, spawned } = run(repo('child', '0.6.0'), ['doctor'], true)
    expect(await result).toBeUndefined()
    expect(lines).toEqual([])
    expect(spawned).toEqual([])
  })

  test('a pin the running kit excludes, not installed, stops with exit 4', async () => {
    const { result } = run(repo('mismatch'), ['build'], false, '0.3.0')
    await expect(result).rejects.toMatchObject({ exitCode: 4 })
  })
})
