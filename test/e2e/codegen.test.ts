import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

let fx: Fixture

const write = (path: string, content: string) => writeFileSync(join(fx.dir, path), content)
const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: fx.dir })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

const CONFIG = (codegen: string) => `export default {
  name: 'Fixture',
  ${codegen}
  workspace: { lint: 'biome check .', typecheck: 'tsc --noEmit' },
  targets: {},
}
`
/** The generator copies `next.txt` to `gen/out.txt`. */
const COPY = "codegen: { run: 'cp next.txt gen/out.txt', outputs: ['gen'] },"

beforeEach(() => {
  fx = fixture('bun-workers', ['biome', 'tsc'])
  mkdirSync(join(fx.dir, 'gen'))
  write('gen/out.txt', 'v1')
  write('next.txt', 'v1')
  write('kit.config.ts', CONFIG(COPY))
  write('.gitignore', '.fakebin\n.calls.log\nnode_modules\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
})
afterEach(() => fx.cleanup())

describe('kit codegen', () => {
  test('runs codegen.run', async () => {
    write('next.txt', 'v2')
    const r = await fx.kit(['codegen'])
    expect(r.code).toBe(0)
    expect(readFileSync(join(fx.dir, 'gen/out.txt'), 'utf8')).toBe('v2')
  })

  test('--check passes when the output matches HEAD', async () => {
    expect((await fx.kit(['codegen', '--check'])).code).toBe(0)
  })

  test('--check lists a changed output, with the hint', async () => {
    write('next.txt', 'v2')
    const r = await fx.kit(['codegen', '--check'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('gen/out.txt')
    expect(r.stderr).toContain('Run `kit codegen` and commit the result')
  })

  test('--check lists an untracked output the generator creates', async () => {
    write('kit.config.ts', CONFIG("codegen: { run: 'echo y > gen/new.txt', outputs: ['gen'] },"))
    git('commit', '-q', '-am', 'config')
    const r = await fx.kit(['codegen', '--check'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('gen/new.txt')
  })

  test('without a codegen block it exits 3 with a hint', async () => {
    write('kit.config.ts', CONFIG(''))
    const r = await fx.kit(['codegen'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('No `codegen`')
  })
})

describe('kit check', () => {
  test('in CI it fails on codegen drift', async () => {
    write('next.txt', 'v2')
    const r = await fx.kit(['check'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Codegen output is out of date')
  })

  test('in CI it passes when the output is up to date', async () => {
    expect((await fx.kit(['check'])).code).toBe(0)
  })

  test('outside CI it skips the drift check unless --codegen', async () => {
    write('next.txt', 'v2')
    expect((await fx.kit(['check'], { env: { CI: '' } })).code).toBe(0)
    expect((await fx.kit(['check', '--codegen'], { env: { CI: '' } })).code).toBe(1)
  })
})
