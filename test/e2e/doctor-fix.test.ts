import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

// `kit doctor --fix` in a Kotlin toolchain repo with five fixable problems: no lefthook hook, a
// drifted mise tool, a module.yaml version behind the TOML, a wrapper that cannot run, and a
// workflow pin behind `.kit/package.json` (1.2.3).

function sh(cmd: string[], cwd: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

// Stands in for kit's GitHub repo, with the tag the fixture pins.
let remote = ''
let sha = ''
beforeAll(() => {
  remote = mkdtempSync(join(tmpdir(), 'kit-remote-'))
  sh(['git', 'init', '-q', '-b', 'main'], remote)
  const git = ['git', '-c', 'user.email=t@example.com', '-c', 'user.name=T']
  sh([...git, 'commit', '-q', '--allow-empty', '-m', 'chore(release): 1.2.3'], remote)
  sh([...git, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3'], remote)
  sha = sh(['git', 'rev-parse', 'HEAD'], remote)
})
afterAll(() => rmSync(remote, { recursive: true, force: true }))

const MODULE = 'androidApp/module.yaml'
const CI = '.github/workflows/ci.yml'
const OLD = `      - uses: jordond/kit/.github/actions/setup@${'a'.repeat(40)} # v1.0.0\n`
const FIXABLE = ['toolchain', 'mise', 'lefthook', 'android-version', 'ci-pin']

let f: Fixture
const read = (p: string) => readFileSync(join(f.dir, p), 'utf8')
const run = (args: string[], env: Record<string, string> = {}) =>
  f.kit(args, { env: { KIT_REPO_URL: remote, ...env } })
const tools = () => f.calls().filter((c) => c.bin === 'mise' || c.bin === 'lefthook')

interface Doc {
  ok: boolean
  checks: {
    id: string
    status: string
    detail?: string
    fix?: { description: string; cmd?: string[]; cwd?: string }
  }[]
  fixes?: { id: string; description: string; applied: boolean; ok: boolean; error?: string; hint?: string }[]
}
const status = (doc: Doc) => Object.fromEntries(doc.checks.map((c) => [c.id, c.status]))

let before: Record<string, string> = {}
beforeEach(() => {
  f = fixture('release-toolchain', ['java', 'ktlint', 'mise', 'lefthook'])
  sh(['git', 'init', '-q', '-b', 'main'], f.dir)
  f.script('ktlint', 'echo 1.8.0')
  // A recording fake that also does what `lefthook install` does.
  appendFileSync(
    join(f.dir, '.fakebin/lefthook'),
    "mkdir -p .git/hooks; echo 'lefthook run pre-commit' > .git/hooks/pre-commit\n",
  )
  writeFileSync(join(f.dir, 'lefthook.yml'), 'pre-commit:\n  commands: {}\n')
  writeFileSync(join(f.dir, 'mise.toml'), '[tools]\nktlint = "9.9.9"\n')
  writeFileSync(join(f.dir, MODULE), read(MODULE).replace(/versionName: .*/, 'versionName: "0.0.1"'))
  chmodSync(join(f.dir, 'kotlin'), 0o644)
  mkdirSync(join(f.dir, '.github/workflows'), { recursive: true })
  writeFileSync(join(f.dir, CI), `jobs:\n  a:\n    steps:\n${OLD}`)
  before = { module: read(MODULE), ci: read(CI) }
})
afterEach(() => f.cleanup())

const untouched = () => {
  expect(tools()).toEqual([])
  expect(read(MODULE)).toBe(before.module!)
  expect(read(CI)).toBe(before.ci!)
  expect(statSync(join(f.dir, 'kotlin')).mode & 0o111).toBe(0)
  expect(existsSync(join(f.dir, '.git/hooks/pre-commit'))).toBe(false)
}

test('plain doctor names how many checks are fixable, and --json carries each fix', async () => {
  const r = await run(['doctor'])
  expect(r.code).toBe(4)
  expect(r.stdout).toBe('')
  expect(r.stderr).toContain('5 fixable with `kit doctor --fix`')
  const doc = JSON.parse((await run(['doctor', '--json'])).stdout) as Doc
  expect(doc.fixes).toBeUndefined()
  expect(doc.checks.filter((c) => c.fix).map((c) => c.id)).toEqual(FIXABLE)
  expect(doc.checks.find((c) => c.id === 'lefthook')?.fix).toEqual({
    description: 'lefthook install',
    cmd: ['lefthook', 'install'],
    cwd: '.',
  })
  untouched()
})

test('--fix --yes applies every fix in order, re-checks, and exits on the state after', async () => {
  const r = await run(['doctor', '--fix', '--yes'])
  expect(r.stdout).toBe('')
  expect(r.stderr).toContain('5 fixable:')
  expect(tools().map((c) => `${c.cwd} ${c.bin} ${c.argv.join(' ')}`)).toEqual([
    '. mise install',
    '. lefthook install',
  ])
  expect(statSync(join(f.dir, 'kotlin')).mode & 0o111).not.toBe(0)
  expect(read(MODULE)).toContain('versionName: "1.4.0"')
  expect(read(CI)).toContain(`jordond/kit/.github/actions/setup@${sha} # v1.2.3`)
  for (const label of ['kotlin toolchain', 'lefthook', 'Android version', 'CI kit pin']) {
    expect(r.stderr).toContain(`✔ fixed ${label}`)
    expect(r.stderr).toMatch(new RegExp(`\\n✔ ${label} `))
  }
  // `mise install` exits 0 and this process still sees the old ktlint: applied, never "fixed".
  expect(r.stderr).not.toContain('fixed mise.toml versions')
  expect(r.stderr).toContain(
    '▲ applied mise install, but mise.toml versions still warns: ktlint 9.9.9 (have 1.8.0)\n  › Open a new shell (or activate mise in this one) so the installed tools are on PATH',
  )
  expect(r.stderr).toMatch(/\n▲ mise\.toml versions\s+ktlint 9\.9\.9 \(have 1\.8\.0\)/)
  expect(r.stderr).not.toContain('fixable with')
  expect(r.code).toBe(0)
})

test('--fix --json: one document with the fixes and the checks after them', async () => {
  const r = await run(['doctor', '--fix', '--yes', '--json'])
  expect(r.stderr).toBe('')
  const doc = JSON.parse(r.stdout) as Doc
  expect(doc.fixes).toEqual([
    { id: 'toolchain', description: 'chmod +x ./kotlin', applied: true, ok: true },
    {
      id: 'mise',
      description: 'mise install',
      applied: true,
      ok: false,
      error: 'mise.toml versions still warns: ktlint 9.9.9 (have 1.8.0)',
      hint: 'Open a new shell (or activate mise in this one) so the installed tools are on PATH',
    },
    { id: 'lefthook', description: 'lefthook install', applied: true, ok: true },
    {
      id: 'android-version',
      description: `set settings.android.versionName: "1.4.0" in ${MODULE}`,
      applied: true,
      ok: true,
    },
    { id: 'ci-pin', description: 'move the workflow pins to v1.2.3', applied: true, ok: true },
  ])
  expect(status(doc)).toMatchObject({
    toolchain: 'ok',
    mise: 'warn',
    lefthook: 'ok',
    'android-version': 'ok',
    'ci-pin': 'ok',
  })
  expect(doc.ok).toBe(true)
  expect(r.code).toBe(0)
})

test('--fix --dry-run lists the fixes and applies nothing', async () => {
  const r = await run(['doctor', '--fix', '--dry-run', '--yes'])
  expect(r.code).toBe(4)
  for (const d of [
    'chmod +x ./kotlin',
    'mise install',
    'lefthook install',
    'move the workflow pins to v1.2.3',
  ])
    expect(r.stderr).toContain(d)
  expect(r.stderr).toContain('Nothing fixed (dry run)')
  untouched()
  const doc = JSON.parse((await run(['doctor', '--fix', '--dry-run', '--json'])).stdout) as Doc
  expect(doc.fixes?.map((x) => [x.id, x.applied, x.ok])).toEqual(FIXABLE.map((id) => [id, false, true]))
  untouched()
})

test('--fix without a terminal and without --yes applies nothing and says so', async () => {
  const r = await run(['doctor', '--fix'])
  expect(r.code).toBe(4)
  expect(r.stderr).toContain('Nothing fixed (no terminal; re-run with --yes)')
  expect(r.stderr).toContain('✖ kotlin toolchain')
  untouched()
  const doc = JSON.parse((await run(['doctor', '--fix', '--json'])).stdout) as Doc
  expect(doc.ok).toBe(false)
  expect(doc.fixes?.every((x) => !x.applied && !x.ok && x.error === 'no terminal; re-run with --yes')).toBe(
    true,
  )
  untouched()
})

test('offline: the workflow pins are skipped with a note, the rest is fixed; --ci still fails', async () => {
  const r = await run(['doctor', '--fix', '--yes', '--ci', '--json'], { KIT_REPO_URL: join(f.dir, 'none') })
  const doc = JSON.parse(r.stdout) as Doc
  expect(doc.fixes?.find((x) => x.id === 'ci-pin')).toEqual({
    id: 'ci-pin',
    description: 'move the workflow pins to v1.2.3',
    applied: false,
    ok: false,
    error: 'v1.2.3 not found in the kit repo (offline?): workflow pins left as they are',
  })
  expect(read(CI)).toBe(before.ci!)
  expect(status(doc)).toMatchObject({ toolchain: 'ok', 'android-version': 'ok', 'ci-pin': 'fail' })
  expect(r.code).toBe(4)
})

test('a fix that fails is reported and the check keeps failing', async () => {
  f.fail('mise', 2, 'mise ERROR no network')
  f.fail('lefthook', 1, 'cannot write hook')
  const r = await run(['doctor', '--fix', '--yes', '--json'])
  const doc = JSON.parse(r.stdout) as Doc
  expect(doc.fixes?.filter((x) => !x.ok)).toEqual([
    {
      id: 'mise',
      description: 'mise install',
      applied: true,
      ok: false,
      error: 'exit 2: mise ERROR no network',
    },
    {
      id: 'lefthook',
      description: 'lefthook install',
      applied: true,
      ok: false,
      error: 'exit 1: cannot write hook',
    },
  ])
  expect(status(doc)).toMatchObject({ mise: 'warn', lefthook: 'warn', toolchain: 'ok' })
})

test('a standalone worker: the install runs in its own dir with its own package manager', async () => {
  // The root has package.json + bun.lock; services/api has its own pnpm-lock.yaml and no wrangler.
  const w = fixture('standalone-worker', [])
  const log = join(w.dir, '.pm.log')
  const pm = (bin: string, extra = '') =>
    w.script(bin, `echo "$(basename "$PWD") ${bin} $*" >> "${log}"\n${extra}`)
  try {
    const plain = JSON.parse((await w.kit(['doctor', '--json'])).stdout) as Doc
    expect(plain.checks.find((c) => c.id === 'wrangler')).toMatchObject({
      status: 'warn',
      detail: 'wrangler not installed',
      hint: 'Run `pnpm install`',
      fix: { description: 'pnpm install', cmd: ['pnpm', 'install'], cwd: 'services/api' },
    })

    // An install that leaves no wrangler behind is applied, not fixed.
    pm('bun')
    pm('pnpm')
    const still = JSON.parse((await w.kit(['doctor', '--fix', '--yes', '--json'])).stdout) as Doc
    expect(still.fixes).toEqual([
      {
        id: 'wrangler',
        description: 'pnpm install',
        applied: true,
        ok: false,
        error: 'wrangler login still warns: wrangler not installed',
        hint: 'Run `pnpm install`',
      },
    ])

    // One that installs it: fixed, and the re-check asks wrangler who is logged in.
    pm('pnpm', 'if [ "$1" = install ]; then mkdir -p node_modules/.bin; : > node_modules/.bin/wrangler; fi')
    const r = await w.kit(['doctor', '--fix', '--yes'])
    expect(r.stderr).toContain('✔ fixed wrangler login')
    expect(r.stderr).toMatch(/\n✔ wrangler login /)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'api pnpm install',
      'api pnpm install',
      'api pnpm exec wrangler whoami',
    ])
    expect(readFileSync(log, 'utf8')).not.toContain(' bun ')
  } finally {
    w.cleanup()
  }
})

test('nothing to fix: --fix is the plain report', async () => {
  const clean = fixture('release-toolchain', ['java', 'ktlint'])
  try {
    const r = await clean.kit(['doctor', '--fix', '--json'])
    const doc = JSON.parse(r.stdout) as Doc
    expect(doc.fixes).toEqual([])
    expect(doc.checks.some((c) => c.fix)).toBe(false)
  } finally {
    clean.cleanup()
  }
})
