import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const KIT = resolve(import.meta.dir, '../..')
let fx: Fixture

beforeEach(() => {
  fx = fixture('bun-workers', [])
})
afterEach(() => fx.cleanup())

describe('kit completion', () => {
  test('zsh: prints a script that calls back through the kit on PATH', async () => {
    const r = await fx.kit(['completion', 'zsh'])
    expect(r.code).toBe(0)
    expect(r.stdout).toStartWith('#compdef kit')
    expect(r.stdout).toContain('requestComp="kit complete -- ')
    expect(r.stdout).not.toContain(KIT)
  })

  test.each(['bash', 'fish'])('%s: prints a script', async (shell) => {
    const r = await fx.kit(['completion', shell])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`${shell} completion for kit`)
  })

  test("the script's callback completes flags of nested commands", async () => {
    const r = await fx.kit(['complete', '--', 'release', 'ios', '--tr'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--track')
  })

  test('the callback lists repo-independent built-ins', async () => {
    const r = await fx.kit(['complete', '--', 'compl'])
    expect(r.stdout).toContain('completion')
  })

  test('a missing or unknown shell is a usage error', async () => {
    expect((await fx.kit(['completion'])).code).toBe(2)
    const r = await fx.kit(['completion', 'pwsh'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('zsh, bash, fish')
  })

  test('--help prints install instructions and runs nothing', async () => {
    const r = await fx.kit(['completion', 'zsh', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('source <(kit completion zsh)')
    expect(r.stdout).not.toContain('#compdef')
  })
})

describe('launcher outside a project', () => {
  // A package copy with no dist/, so bin/kit falls through to step 3 and runs the sources.
  let pkg = ''
  let away = ''
  beforeAll(() => {
    pkg = mkdtempSync(join(tmpdir(), 'kit-launcher-'))
    mkdirSync(join(pkg, 'bin'))
    cpSync(join(KIT, 'bin/kit'), join(pkg, 'bin/kit'))
    for (const p of ['src', 'node_modules', 'package.json']) symlinkSync(join(KIT, p), join(pkg, p))
    away = mkdtempSync(join(tmpdir(), 'kit-away-'))
  })
  afterAll(() => {
    rmSync(pkg, { recursive: true, force: true })
    rmSync(away, { recursive: true, force: true })
  })

  const launch = async (args: string[]) => {
    const proc = Bun.spawn(['sh', join(pkg, 'bin/kit'), ...args], {
      cwd: away,
      env: { ...process.env, NO_COLOR: '1', KIT_DEV: '', KIT_ROOT: '' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    return { code: await proc.exited, stdout }
  }

  test('completion and its callback work with no kit.config.ts', async () => {
    const script = await launch(['completion', 'bash'])
    expect(script.code).toBe(0)
    expect(script.stdout).toContain('bash completion for kit')
    const words = await launch(['complete', '--', 'doc'])
    expect(words.code).toBe(0)
    expect(words.stdout).toContain('doctor')
  })
})
