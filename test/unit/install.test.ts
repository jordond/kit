import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { missingInstall } from '../../src/lib/pm'
import { installGroup, planVerbs } from '../../src/lib/targets'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A temp repo with `files` (path → content; a path ending in `/` is a directory). */
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-install-')))
  dirs.push(root)
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    if (path.endsWith('/')) mkdirSync(file, { recursive: true })
    else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
  }
  return root
}

const pkg = JSON.stringify({ dependencies: { astro: '^7' }, scripts: { build: 'astro build' } })
const config = configSchema.parse({
  name: 'app',
  targets: {
    app: { kind: 'kotlin', dir: '.' },
    site: { kind: 'astro', dir: 'site' },
  },
})

describe('missingInstall', () => {
  test('a package.json with dependencies and no node_modules: the lockfile picks the package manager', () => {
    const root = repo({ 'site/package.json': pkg, 'site/pnpm-lock.yaml': '' })
    expect(missingInstall(join(root, 'site'), root)).toEqual({
      cmd: ['pnpm', 'install'],
      cwd: join(root, 'site'),
    })
  })
  test('installs where the lockfile is, not in the package dir', () => {
    const root = repo({ 'package.json': pkg, 'bun.lock': '', 'site/package.json': pkg })
    expect(missingInstall(join(root, 'site'), root)).toEqual({ cmd: ['bun', 'install'], cwd: root })
  })
  test('nothing when node_modules exists, or when there is nothing to install', () => {
    const installed = repo({ 'site/package.json': pkg, 'site/node_modules/': '' })
    expect(missingInstall(join(installed, 'site'), installed)).toBeUndefined()
    const empty = repo({ 'site/package.json': '{"scripts":{}}' })
    expect(missingInstall(join(empty, 'site'), empty)).toBeUndefined()
    const none = repo({ 'site/': '' })
    expect(missingInstall(join(none, 'site'), none)).toBeUndefined()
  })
})

describe('installGroup', () => {
  test('JS targets only, one command per install root', () => {
    const root = repo({ 'package.json': pkg, 'site/package.json': pkg, 'site/bun.lock': '' })
    // The kotlin target at the root does not install the root package.json.
    expect(installGroup(root, config, ['app', 'site'])).toEqual({
      title: 'install',
      commands: [{ title: 'bun install (site)', cmd: ['bun', 'install'], cwd: join(root, 'site') }],
    })
    expect(installGroup(root, config, ['app'])).toBeUndefined()
    expect(installGroup(root, config, ['app'], true)?.commands.map((c) => c.title)).toEqual(['bun install'])
  })
})

describe('planVerbs', () => {
  test('a missing install runs first; an installed target plans as before', () => {
    const root = repo({ 'site/package.json': pkg, 'site/bun.lock': '' })
    expect(planVerbs(root, config, ['build'], { targets: ['site'] }).map((g) => g.title)).toEqual([
      'install',
      'site',
    ])
    mkdirSync(join(root, 'site/node_modules'))
    expect(planVerbs(root, config, ['build'], { targets: ['site'] }).map((g) => g.title)).toEqual(['site'])
  })
  test('no install for a target the verb does not run', () => {
    const root = repo({ 'site/package.json': pkg, 'site/bun.lock': '' })
    expect(planVerbs(root, config, ['test'], { targets: ['site'] })).toEqual([])
  })
})
