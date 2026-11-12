import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { localD1Files, previewMarker } from '../../src/lib/worker'
import { type Fixture, fixture } from '../helpers/fixture'

const KIT = resolve(import.meta.dir, '../..')
const EDGE_ID = '0123456789abcdef0123456789abcdef'
const VERSION = '11111111-2222-4333-8444-555555555555'
const OPENER = process.platform === 'darwin' ? 'open' : 'xdg-open'
let fx: Fixture

// The infra fixture plus: an env and a before hook on edge, a non-worker target, a seed file and
// release services (a worker, a non-worker, a shell deploy).
const CONFIG = `export default {
  name: 'Infra',
  env: {
    schema: '.kit/env.ts',
    outputs: { 'apps/edge/.dev.vars': { pick: ['API_SECRET'] } },
  },
  versions: { file: 'versions.toml', keys: { edge: 'edge-version', rollback: 'edge-version' } },
  targets: {
    edge: { kind: 'worker', dir: 'apps/edge', envs: ['staging'], deploy: { before: ['env sync'] } },
    admin: { kind: 'worker', dir: 'apps/admin' },
    analytics: { kind: 'worker', dir: 'apps/analytics' },
    site: { kind: 'astro', dir: 'apps/site' },
  },
  cloudflare: {
    accountId: 'from-wrangler',
    d1: {
      db: { name: 'infra-db', target: 'edge', seed: 'apps/edge/seed.sql' },
      analytics: { name: 'infra-analytics', target: 'analytics' },
    },
  },
  release: {
    services: {
      edge: { versionKey: 'edge', deploy: 'kit deploy edge --env staging' },
      site: { versionKey: 'edge', deploy: 'kit deploy site' },
      script: { versionKey: 'edge', deploy: './deploy.sh' },
      /*ROLLBACK*/
    },
  },
}
`

/** Records argv, cwd and the account id it saw; `versions upload` answers the way wrangler does. */
function fakeWrangler(): string {
  const log = join(fx.dir, '.calls.log')
  return `printf '%s\\n' "$(bun -e 'console.log(JSON.stringify({bin:process.argv[1],argv:process.argv.slice(2),cwd:process.cwd()}))' wrangler "$@")" >> "${log}"
echo "$CLOUDFLARE_ACCOUNT_ID" >> "${fx.dir}/.account.log"
f="${fx.dir}/.fakebin/wrangler.fail"
if [ -f "$f" ]; then cat "$f.out" 2>/dev/null; exit "$(cat "$f")"; fi
if [ "$1 $2" = "versions upload" ]; then
  echo "Uploaded edge (1.20 sec)"
  echo "Worker Version ID: ${VERSION}"
  echo "Version Preview URL: https://11111111-edge.acme.workers.dev"
  case "$*" in *--preview-alias*) echo "Version Preview Alias URL: https://feat-add-thing-edge.acme.workers.dev" ;; esac
  exit 0
fi
echo "wrangler ok"`
}

beforeEach(() => {
  fx = fixture('infra', ['wrangler', 'gh', 'open', 'xdg-open'])
  symlinkSync(join(KIT, 'node_modules/zod'), join(fx.dir, 'node_modules/zod'))
  writeFileSync(join(fx.dir, 'kit.config.ts'), CONFIG)
  writeFileSync(join(fx.dir, 'versions.toml'), '[versions]\nedge-version = "1.2.3"\n')
  mkdirSync(join(fx.dir, 'apps/site'))
  writeFileSync(join(fx.dir, 'apps/edge/seed.sql'), 'INSERT INTO t VALUES (1);\n')
  fx.script('wrangler', fakeWrangler())
})
afterEach(() => fx.cleanup())

const root = () => realpathSync(fx.dir)
/** Calls with the fixture's absolute path spelled `<root>`. */
const summary = () =>
  fx.calls().map((c) => `${c.cwd} ${c.bin} ${c.argv.join(' ').replaceAll(root(), '<root>')}`)
const read = (p: string) => readFileSync(join(fx.dir, p), 'utf8')
const accounts = () => read('.account.log').trim().split('\n')
const BRANCH = { GITHUB_HEAD_REF: 'feat/Add_Thing' }

describe('deploy --preview', () => {
  test('uploads a version with an alias from the branch; the URL alone is on stdout', async () => {
    const r = await fx.kit(['deploy', 'edge', '--preview'], {
      env: { ...BRANCH, CLOUDFLARE_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('https://feat-add-thing-edge.acme.workers.dev\n')
    expect(summary()).toEqual(['./apps/edge wrangler versions upload --preview-alias feat-add-thing'])
    expect(accounts()).toEqual([EDGE_ID])
    // deploy.before ran first.
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(true)
    expect(r.stderr).toContain('Worker Version ID')
  })

  test('--env and --json: { target, url, version }', async () => {
    const r = await fx.kit(['deploy', 'edge', '--preview', '--env', 'staging', '--json'], { env: BRANCH })
    expect(r.code).toBe(0)
    expect(summary()).toEqual([
      './apps/edge wrangler versions upload --env staging --preview-alias feat-add-thing',
    ])
    expect(JSON.parse(r.stdout)).toEqual({
      target: 'edge',
      env: 'staging',
      url: 'https://feat-add-thing-edge.acme.workers.dev',
      version: VERSION,
      alias: 'feat-add-thing',
    })
  })

  test('no branch: no alias, the version URL', async () => {
    const r = await fx.kit(['deploy', 'edge', '--preview'], { env: { GITHUB_HEAD_REF: '' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('https://11111111-edge.acme.workers.dev\n')
    expect(summary()).toEqual(['./apps/edge wrangler versions upload'])
  })

  test('--dry-run runs nothing', async () => {
    const r = await fx.kit(['deploy', 'edge', '--preview', '--comment', '--dry-run'], { env: BRANCH })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('edge  kit env sync')
    expect(r.stderr).toContain('wrangler versions upload --preview-alias feat-add-thing')
    expect(fx.calls()).toEqual([])
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(false)
  })

  test('usage errors: not a worker, several targets, --comment alone, unknown env', async () => {
    const site = await fx.kit(['deploy', 'site', '--preview'])
    expect(site.code).toBe(2)
    expect(site.stderr).toContain('worker targets only; "site" is astro')
    expect((await fx.kit(['deploy', 'edge', 'admin', '--preview'])).code).toBe(2)
    expect((await fx.kit(['deploy', 'edge', '--comment'])).code).toBe(2)
    expect((await fx.kit(['deploy', 'edge', '--preview', '--env', 'nope'])).code).toBe(2)
    expect(fx.calls()).toEqual([])
  })

  test('a failed upload exits 1 with nothing on stdout', async () => {
    fx.fail('wrangler', 1, 'Authentication error')
    const r = await fx.kit(['deploy', 'admin', '--preview'], { env: BRANCH })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('preview admin failed')
  })

  const body = [
    previewMarker('admin'),
    'Preview of `admin`: https://feat-add-thing-edge.acme.workers.dev',
    '',
    `Version \`${VERSION}\``,
  ].join('\n')

  test('--comment without a PR warns and still succeeds', async () => {
    fx.fail('gh', 1, 'no pull requests found')
    const r = await fx.kit(['deploy', 'admin', '--preview', '--comment'], { env: BRANCH })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('https://feat-add-thing-edge.acme.workers.dev\n')
    expect(r.stderr).toContain('no pull request for feat/Add_Thing')
    expect(summary().slice(1)).toEqual(['. gh pr view feat/Add_Thing --json number,comments'])
  })

  test('--comment posts on the PR', async () => {
    const log = join(fx.dir, '.calls.log')
    fx.script(
      'gh',
      `printf '%s\\n' "$(bun -e 'console.log(JSON.stringify({bin:process.argv[1],argv:process.argv.slice(2),cwd:process.cwd()}))' gh "$@")" >> "${log}"
if [ "$2" = view ]; then echo '{"number":12,"comments":[{"body":"lgtm","url":"https://github.com/o/r/pull/12#issuecomment-1"}]}'; fi`,
    )
    const r = await fx.kit(['deploy', 'admin', '--preview', '--comment', '--json'], { env: BRANCH })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).comment).toBe('created')
    expect(fx.calls().slice(1)).toEqual([
      { bin: 'gh', argv: ['pr', 'view', 'feat/Add_Thing', '--json', 'number,comments'], cwd: '.' },
      { bin: 'gh', argv: ['pr', 'comment', '12', '--body', body], cwd: '.' },
    ])
  })

  test("--comment updates kit's earlier comment for the target, nobody else's", async () => {
    const log = join(fx.dir, '.calls.log')
    // From a file: sh's echo would turn the \\n inside the JSON into a newline.
    const pr = {
      number: 12,
      comments: [
        { body: 'lgtm', url: 'https://github.com/o/r/pull/12#issuecomment-1' },
        { body: `${previewMarker('edge')}\nold`, url: 'https://github.com/o/r/pull/12#issuecomment-2' },
        { body: `${previewMarker('admin')}\nold`, url: 'https://github.com/o/r/pull/12#issuecomment-987' },
      ],
    }
    writeFileSync(join(fx.dir, '.pr.json'), JSON.stringify(pr))
    fx.script(
      'gh',
      `printf '%s\\n' "$(bun -e 'console.log(JSON.stringify({bin:process.argv[1],argv:process.argv.slice(2),cwd:process.cwd()}))' gh "$@")" >> "${log}"
if [ "$2" = view ]; then cat "${fx.dir}/.pr.json"; fi`,
    )
    const r = await fx.kit(['deploy', 'admin', '--preview', '--comment'], { env: BRANCH })
    expect(r.code).toBe(0)
    expect(fx.calls().at(-1)).toEqual({
      bin: 'gh',
      argv: ['api', '--method', 'PATCH', 'repos/{owner}/{repo}/issues/comments/987', '-f', `body=${body}`],
      cwd: '.',
    })
  })
})

describe('release rollback', () => {
  function git(...args: string[]) {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: fx.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }

  test('confirms: exit 2 without --yes; --yes runs wrangler rollback in the target dir, account pinned', async () => {
    expect((await fx.kit(['release', 'rollback', 'edge'])).code).toBe(2)
    expect(fx.calls()).toEqual([])
    const r = await fx.kit(['release', 'rollback', 'edge', '--yes'], {
      env: { CLOUDFLARE_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(r.code).toBe(0)
    expect(fx.calls()).toEqual([
      {
        bin: 'wrangler',
        argv: ['rollback', '--env', 'staging', '--message', 'kit release rollback edge', '--yes'],
        cwd: './apps/edge',
      },
    ])
    expect(accounts()).toEqual([EDGE_ID])
  })

  test('--to names the version; tags stay and the stale one is named', async () => {
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('tag', 'edge/v1.2.3')
    const r = await fx.kit(['release', 'rollback', 'edge', '--to', VERSION, '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(fx.calls()[0]!.argv.slice(0, 2)).toEqual(['rollback', VERSION])
    expect(JSON.parse(r.stdout)).toEqual({
      service: 'edge',
      target: 'edge',
      env: 'staging',
      to: VERSION,
      ok: true,
      staleTag: 'edge/v1.2.3',
    })
    expect(r.stderr).toContain('tag edge/v1.2.3 no longer matches production')
    expect(git('tag')).toBe('edge/v1.2.3')
  })

  test('--dry-run runs nothing', async () => {
    const r = await fx.kit(['release', 'rollback', 'edge', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('apps/edge $ bun x wrangler rollback --env staging')
    expect(fx.calls()).toEqual([])
  })

  test('a failed rollback exits 1', async () => {
    fx.fail('wrangler', 1, 'nope')
    expect((await fx.kit(['release', 'rollback', 'edge', '--yes'])).code).toBe(1)
  })

  test('worker-only: other deploys and unknown services exit 2', async () => {
    for (const svc of ['site', 'script']) {
      const r = await fx.kit(['release', 'rollback', svc, '--yes'])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(`Cannot roll back ${svc}: rollback is worker-only`)
    }
    const unknown = await fx.kit(['release', 'rollback', 'nope', '--yes'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('Services: edge, site, script')
    expect((await fx.kit(['release', 'rollback'])).code).toBe(2)
    expect(fx.calls()).toEqual([])
  })

  test('a service named rollback wins, with a warning', async () => {
    writeFileSync(
      join(fx.dir, 'kit.config.ts'),
      CONFIG.replace('/*ROLLBACK*/', "rollback: { versionKey: 'rollback', deploy: 'kit deploy edge' },"),
    )
    const r = await fx.kit(['release', 'rollback', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('release.services.rollback takes `kit release rollback`')
    expect(JSON.parse(r.stdout)).toMatchObject({ service: 'rollback', tag: 'rollback/v1.2.3', dryRun: true })
    expect(fx.calls()).toEqual([])
  })
})

describe('logs', () => {
  test('tails from the target dir with the account pinned; args after -- pass through', async () => {
    const r = await fx.kit(['logs', 'edge', '--env', 'staging', '--', '--status', 'error'], {
      env: { CLOUDFLARE_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['./apps/edge wrangler tail --env staging --status error'])
    expect(accounts()).toEqual([EDGE_ID])
    expect(r.stdout).toBe('wrangler ok\n')
  })

  test('worker targets only; --dry-run runs nothing; a failed tail exits 1', async () => {
    const site = await fx.kit(['logs', 'site'])
    expect(site.code).toBe(2)
    expect(site.stderr).toContain('Worker targets: edge, admin, analytics')
    expect((await fx.kit(['logs'])).code).toBe(2)
    const dry = await fx.kit(['logs', 'admin', '--dry-run', '--json'])
    expect(JSON.parse(dry.stdout)).toEqual({
      dryRun: true,
      target: 'admin',
      cmd: ['bun', 'x', 'wrangler', 'tail'],
      cwd: 'apps/admin',
    })
    expect(fx.calls()).toEqual([])
    fx.fail('wrangler', 5)
    expect((await fx.kit(['logs', 'admin'])).code).toBe(1)
  })

  test('Ctrl-C ends the tail and exits 130', async () => {
    fx.script('wrangler', 'exec sleep 20')
    const proc = fx.spawn(['logs', 'edge'])
    await Bun.sleep(1500)
    const started = Date.now()
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(130)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('open', () => {
  const url = `https://dash.cloudflare.com/${EDGE_ID}/workers/services/view/edge/production`

  test('--print and --json write the URL and open nothing', async () => {
    const p = await fx.kit(['open', 'edge', '--print'])
    expect(p.code).toBe(0)
    expect(p.stdout).toBe(`${url}\n`)
    const j = await fx.kit(['open', 'edge', '--env', 'staging', '--json'])
    expect(JSON.parse(j.stdout)).toEqual({
      target: 'edge',
      env: 'staging',
      worker: 'edge-staging',
      url: url.replace('/edge/', '/edge-staging/'),
    })
    expect(fx.calls()).toEqual([])
  })

  test('opens the dashboard page; --dry-run does not', async () => {
    const dry = await fx.kit(['open', 'edge', '--dry-run'])
    expect(dry.code).toBe(0)
    expect(fx.calls()).toEqual([])
    const r = await fx.kit(['open', 'edge'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(fx.calls().map((c) => [c.bin, ...c.argv])).toEqual([[OPENER, url]])
  })

  test('a TOML worker uses its own name; the account is still the pinned one', async () => {
    const r = await fx.kit(['open', 'analytics', '--print'])
    expect(r.stdout).toBe(
      `https://dash.cloudflare.com/${EDGE_ID}/workers/services/view/analytics/production\n`,
    )
  })

  test('worker targets only (exit 2); a worker without a wrangler name exits 3', async () => {
    const site = await fx.kit(['open', 'site'])
    expect(site.code).toBe(2)
    expect(site.stderr).toContain('kit open supports worker targets only; "site" is astro')
    expect(site.stderr).toContain('Worker targets: edge, admin, analytics')
    expect((await fx.kit(['open', 'admin', '--print'])).code).toBe(3)
    expect(fx.calls()).toEqual([])
  })
})

describe('db backup / restore / seed / reset', () => {
  test('backup exports to backups/<db>-<UTC>.sql and prints the path', async () => {
    const r = await fx.kit(['db', 'backup', '--db', 'db'], {
      env: { CLOUDFLARE_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^backups\/infra-db-\d{8}T\d{6}Z\.sql\n$/)
    expect(summary()).toEqual([
      `./apps/edge wrangler d1 export infra-db --local --output <root>/${r.stdout.trim()}`,
    ])
    expect(accounts()).toEqual([EDGE_ID])
    expect(existsSync(join(fx.dir, 'backups'))).toBe(true)
  })

  test('backup --remote needs no confirmation; --out is relative to the cwd; --json names the file', async () => {
    const r = await fx.kit(['db', 'backup', '--db', 'analytics', '--remote', '--out', 'prod.sql', '--json'], {
      cwd: 'apps',
    })
    expect(r.code).toBe(0)
    expect(summary()).toEqual([
      './apps/analytics wrangler d1 export infra-analytics --remote --output <root>/apps/prod.sql',
    ])
    expect(JSON.parse(r.stdout)).toMatchObject({
      db: 'infra-analytics',
      remote: true,
      ok: true,
      file: 'prod.sql',
    })
  })

  test('backup --dry-run runs nothing and creates no directory', async () => {
    const r = await fx.kit(['db', 'backup', '--db', 'db', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('wrangler d1 export infra-db --local --output')
    expect(fx.calls()).toEqual([])
    expect(existsSync(join(fx.dir, 'backups'))).toBe(false)
  })

  test('restore runs the file; remote confirms; a missing file is a usage error', async () => {
    writeFileSync(join(fx.dir, 'dump.sql'), 'SELECT 1;\n')
    expect((await fx.kit(['db', 'restore', 'nope.sql', '--db', 'db'])).code).toBe(2)
    expect((await fx.kit(['db', 'restore', '--db', 'db'])).code).toBe(2)
    expect((await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--remote'])).code).toBe(2)
    expect(fx.calls()).toEqual([])
    expect((await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db'])).code).toBe(0)
    expect((await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--remote', '--yes'])).code).toBe(0)
    expect(summary()).toEqual([
      './apps/edge wrangler d1 execute infra-db --local --file <root>/dump.sql',
      './apps/edge wrangler d1 execute infra-db --remote --file <root>/dump.sql',
    ])
  })

  test('seed runs cloudflare.d1.<db>.seed; none configured exits 3; remote confirms', async () => {
    const none = await fx.kit(['db', 'seed', '--db', 'analytics'])
    expect(none.code).toBe(3)
    expect(none.stderr).toContain('cloudflare.d1.analytics.seed')
    expect((await fx.kit(['db', 'seed', '--db', 'db', '--remote'])).code).toBe(2)
    expect((await fx.kit(['db', 'seed', '--db', 'db', '--dry-run'])).code).toBe(0)
    expect(fx.calls()).toEqual([])
    expect((await fx.kit(['db', 'seed', '--db', 'db'])).code).toBe(0)
    expect(summary()).toEqual([
      './apps/edge wrangler d1 execute infra-db --local --file <root>/apps/edge/seed.sql',
    ])
  })

  describe('reset', () => {
    // edge's wrangler.jsonc has no database_id, so wrangler keys the local database by its binding.
    const mine = () => localD1Files(join(fx.dir, 'apps/edge'), 'DB')
    const other = () => localD1Files(join(fx.dir, 'apps/edge'), 'OTHER')[0]!
    beforeEach(() => {
      mkdirSync(dirname(other()), { recursive: true })
      for (const f of [...mine(), other()]) writeFileSync(f, 'sqlite')
    })

    test('--remote is a usage error; without --yes nothing is deleted', async () => {
      const remote = await fx.kit(['db', 'reset', '--db', 'db', '--remote', '--yes'])
      expect(remote.code).toBe(2)
      expect(remote.stderr).toContain('kit db reset is local only')
      expect((await fx.kit(['db', 'reset', '--db', 'db'])).code).toBe(2)
      expect(mine().every((f) => existsSync(f))).toBe(true)
      expect(fx.calls()).toEqual([])
    })

    test('--yes deletes that database only, migrates, then seeds', async () => {
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes'], {
        env: { CLOUDFLARE_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef' },
      })
      expect(r.code).toBe(0)
      expect(mine().some((f) => existsSync(f))).toBe(false)
      expect(existsSync(other())).toBe(true)
      expect(summary()).toEqual([
        './apps/edge wrangler d1 migrations apply infra-db --local',
        './apps/edge wrangler d1 execute infra-db --local --file <root>/apps/edge/seed.sql',
      ])
      expect(new Set(accounts())).toEqual(new Set([EDGE_ID]))
    })

    test('--dry-run deletes and runs nothing', async () => {
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--dry-run', '--json'])
      expect(r.code).toBe(0)
      const doc = JSON.parse(r.stdout)
      expect(doc.remove).toHaveLength(3)
      expect(doc.plan.map((p: { title: string }) => p.title)).toEqual(['migrate', 'seed'])
      expect(mine().every((f) => existsSync(f))).toBe(true)
      expect(fx.calls()).toEqual([])
    })

    test('a failed migrate exits 1 and skips the seed', async () => {
      fx.fail('wrangler', 1, 'bad migration')
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes', '--json'])
      expect(r.code).toBe(1)
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, steps: [{ title: 'migrate', code: 1 }] })
      expect(fx.calls()).toHaveLength(1)
    })

    test('removed files are in the --json document', async () => {
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes', '--json'])
      expect(r.code).toBe(0)
      const doc = JSON.parse(r.stdout)
      expect(doc.ok).toBe(true)
      expect(doc.removed).toEqual(mine().map((f) => f.slice(fx.dir.length + 1)))
    })

    test('sqlite files but none for this database: exit 1 before migrating, nothing deleted', async () => {
      for (const f of mine()) rmSync(f)
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('Local D1 layout not recognised: apps/edge/.wrangler/state/v3/d1')
      expect(r.stderr).toContain('kit clean --deep')
      expect(existsSync(other())).toBe(true)
      expect(fx.calls()).toEqual([])
      const j = await fx.kit(['db', 'reset', '--db', 'db', '--yes', '--json'])
      expect(j.code).toBe(1)
      expect(JSON.parse(j.stdout).ok).toBe(false)
      expect(fx.calls()).toEqual([])
    })

    test("only the worker's other database exists locally: this one is fresh, the other untouched", async () => {
      writeFileSync(
        join(fx.dir, 'apps/edge/wrangler.jsonc'),
        JSON.stringify({
          name: 'edge',
          account_id: EDGE_ID,
          d1_databases: [
            { binding: 'DB', database_name: 'infra-db' },
            { binding: 'OTHER', database_name: 'infra-other' },
          ],
        }),
      )
      writeFileSync(
        join(fx.dir, 'kit.config.ts'),
        CONFIG.replace(
          'analytics: { name:',
          "other: { name: 'infra-other', target: 'edge' }, analytics: { name:",
        ),
      )
      for (const f of mine()) rmSync(f)
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes'])
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('no local infra-db to remove')
      expect(readFileSync(other(), 'utf8')).toBe('sqlite')
      expect(summary()).toEqual([
        './apps/edge wrangler d1 migrations apply infra-db --local',
        './apps/edge wrangler d1 execute infra-db --local --file <root>/apps/edge/seed.sql',
      ])
    })

    test('no state directory: a fresh checkout migrates and seeds, saying nothing was removed', async () => {
      rmSync(join(fx.dir, 'apps/edge/.wrangler'), { recursive: true })
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes'])
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('no local infra-db to remove')
      expect(fx.calls()).toHaveLength(2)
    })

    test('a state directory without sqlite files is fresh too; --json reports removed: []', async () => {
      for (const f of [...mine(), other()]) rmSync(f)
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes', '--json'])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, removed: [] })
      expect(fx.calls()).toHaveLength(2)
    })

    test('a database missing from the wrangler config exits 3 before deleting anything', async () => {
      const r = await fx.kit(['db', 'reset', '--db', 'analytics', '--yes'])
      expect(r.code).toBe(3)
      expect(r.stderr).toContain('No d1_databases entry for infra-analytics in apps/analytics/wrangler.toml')
    })
  })
})
