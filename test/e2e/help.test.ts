import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { builtins } from '../../src/cli/builtins'

// Help snapshots (PLAN §14), run outside any project so no app name or repo command leaks in.
// A changed description, flag or example shows up here: review it, then `bun test --update-snapshots`.
const KIT = resolve(import.meta.dir, '../..')
let away = ''
beforeAll(() => {
  away = mkdtempSync(join(tmpdir(), 'kit-help-'))
})
afterAll(() => rmSync(away, { recursive: true, force: true }))

async function help(args: string[]) {
  const proc = Bun.spawn(['bun', '--no-env-file', join(KIT, 'src/cli.ts'), ...args, '--help'], {
    cwd: away,
    env: { ...process.env, NO_COLOR: '1', CI: 'true', KIT_ROOT: '' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited).toBe(0)
  expect(stderr).toBe('')
  return stdout
}

const groups = [...new Set(builtins.filter((b) => b.path.length > 1).map((b) => b.path[0]!))].sort()
const commands = builtins.map((b) => b.path.join(' ')).sort()

describe('help', () => {
  test('kit --help', async () => {
    expect(await help([])).toMatchSnapshot()
  })

  test.each(groups)('kit %s --help', async (group) => {
    expect(await help([group])).toMatchSnapshot()
  })

  test.each(commands)('kit %s --help', async (path) => {
    expect(await help(path.split(' '))).toMatchSnapshot()
  })
})
