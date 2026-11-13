import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPathKit } from '../../src/lib/doctor/checks'
import { compareVersions, copyVerdict, kitCopyAt, pathKit, repoKit } from '../../src/lib/kit-copy'

const tmp = mkdtempSync(join(tmpdir(), 'kit-copy-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const write = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

/** A kit package dir with a `dist/cli.js`. */
function kitAt(dir: string, version: string): string {
  write(join(dir, 'package.json'), JSON.stringify({ name: '@jordond/kit', version }))
  write(join(dir, 'dist/cli.js'), '')
  write(join(dir, 'bin/kit'), '')
  return dir
}

/** A repo that pins kit in `<install>/package.json`; `installed` puts a copy in its node_modules. */
function repo(name: string, opts: { install?: '.' | '.kit'; range?: string; installed?: string }): string {
  const root = join(tmp, name)
  const install = opts.install ?? '.'
  write(
    join(root, install, 'package.json'),
    JSON.stringify(opts.range === undefined ? {} : { devDependencies: { '@jordond/kit': opts.range } }),
  )
  if (opts.installed) kitAt(join(root, install, 'node_modules/@jordond/kit'), opts.installed)
  return root
}

const global = { dir: kitAt(join(tmp, 'global/node_modules/@jordond/kit'), '0.3.0'), version: '0.3.0' }

describe('which kit runs in a repo', () => {
  test('repoKit reads the pin and the installed copy from the root or .kit', () => {
    expect(repoKit(join(tmp, 'nowhere'))).toBeUndefined()
    expect(repoKit(repo('plain', {}))).toEqual({ manifest: 'package.json' })
    const root = repo('dot', { install: '.kit', range: '^0.7.1', installed: '0.7.1' })
    const dir = join(root, '.kit/node_modules/@jordond/kit')
    expect(repoKit(root)).toEqual({
      manifest: '.kit/package.json',
      range: '^0.7.1',
      installed: { dir, version: '0.7.1', cli: join(dir, 'dist/cli.js') },
    })
  })

  test('an older global kit hands off to the copy the repo has installed', () => {
    const root = repo('handoff', { install: '.kit', range: '^0.7.1', installed: '0.7.1' })
    expect(copyVerdict(root, global)).toEqual({
      kind: 'handoff',
      cli: join(root, '.kit/node_modules/@jordond/kit/dist/cli.js'),
      version: '0.7.1',
    })
  })

  test('the repo copy itself is the right one, through a symlink too', () => {
    const root = repo('own', { range: '^0.7.1', installed: '0.7.1' })
    const dir = join(root, 'node_modules/@jordond/kit')
    expect(copyVerdict(root, { dir, version: '0.7.1' })).toEqual({ kind: 'ok' })
    const link = join(tmp, 'link-to-own')
    symlinkSync(dir, link)
    expect(copyVerdict(root, { dir: link, version: '0.7.1' })).toEqual({ kind: 'ok' })
  })

  test('a pin this copy does not satisfy is a mismatch when the repo copy is not installed', () => {
    const root = repo('missing', { install: '.kit', range: '^0.7.1' })
    expect(copyVerdict(root, global)).toEqual({
      kind: 'mismatch',
      range: '^0.7.1',
      manifest: '.kit/package.json',
    })
    expect(copyVerdict(root, { dir: global.dir, version: '0.7.4' })).toEqual({ kind: 'ok' })
  })

  test('a range that is not a version range is not judged', () => {
    for (const range of ['workspace:*', 'link:../kit', 'latest', 'catalog:']) {
      expect(copyVerdict(repo(`odd-${range.replace(/\W/g, '')}`, { range }), global)).toEqual({ kind: 'ok' })
    }
    expect(copyVerdict(repo('unpinned', {}), global)).toEqual({ kind: 'ok' })
  })

  test('kitCopyAt finds the package from a file inside it; pathKit follows the launcher symlink', () => {
    expect(kitCopyAt(join(global.dir, 'dist'))).toEqual(global)
    expect(kitCopyAt(tmp)).toBeUndefined()
    const bin = join(tmp, 'bin/kit')
    mkdirSync(join(tmp, 'bin'), { recursive: true })
    symlinkSync(join(global.dir, 'bin/kit'), bin)
    expect(pathKit(() => bin)?.version).toBe('0.3.0')
    expect(pathKit(() => null)).toBeUndefined()
  })

  test('doctor warns about an older kit on PATH and names the fix', () => {
    expect(compareVersions('0.3.0', '0.7.1')).toBeLessThan(0)
    expect(checkPathKit(undefined, '0.7.1', false)).toBeUndefined()
    expect(checkPathKit('0.8.0', '0.7.1', false)).toMatchObject({ status: 'ok', detail: '0.8.0' })
    const check = checkPathKit('0.3.0', '0.7.1', true)
    expect(check).toMatchObject({ id: 'kit', status: 'warn' })
    expect(check?.hint).toContain('bun add -g @jordond/kit@0.7.1')
  })
})
