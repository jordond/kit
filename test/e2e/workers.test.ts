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

/**
 * Records argv, cwd and the account id it saw, and answers the way wrangler does: `versions upload`
 * prints the URLs, the listings print `.deployments.json` / `.versions.json` / `.tables.json`, and a
 * local `d1 migrations apply` or `d1 execute --file` leaves infra-db's SQLite file behind (unless
 * `.no-d1-file` exists: a wrangler that keeps local state somewhere else).
 */
function fakeWrangler(): string {
  const log = join(fx.dir, '.calls.log')
  const sqlite = localD1Files(join(fx.dir, 'apps/edge'), 'DB')[0]!
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
case "$*" in
  "deployments list"*) cat "${fx.dir}/.deployments.json" 2>/dev/null || echo '[]'; exit 0 ;;
  "versions list"*) cat "${fx.dir}/.versions.json" 2>/dev/null || echo '[]'; exit 0 ;;
  *sqlite_master*) cat "${fx.dir}/.tables.json" 2>/dev/null || echo '[{"results":[],"success":true}]'; exit 0 ;;
  "d1 migrations apply infra-db --local"*|"d1 execute infra-db --local --file"*)
    if [ ! -f "${fx.dir}/.no-d1-file" ]; then mkdir -p "${dirname(sqlite)}"; : > "${sqlite}"; fi ;;
esac
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
      ok: true,
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
    fx.script('gh', 'echo "no pull requests found for branch feat/Add_Thing" >&2; exit 1')
    const r = await fx.kit(['deploy', 'admin', '--preview', '--comment'], { env: BRANCH })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('https://feat-add-thing-edge.acme.workers.dev\n')
    expect(r.stderr).toContain('no pull request for feat/Add_Thing')
  })

  test('--comment: any other gh failure exits 1, after the URL is on stdout', async () => {
    fx.fail('gh', 4, 'gh: To get started with GitHub CLI, please run: gh auth login')
    const r = await fx.kit(['deploy', 'admin', '--preview', '--comment'], { env: BRANCH })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('https://feat-add-thing-edge.acme.workers.dev\n')
    expect(r.stderr).toContain('could not look up the pull request')
    const j = await fx.kit(['deploy', 'admin', '--preview', '--comment', '--json'], { env: BRANCH })
    expect(j.code).toBe(1)
    expect(JSON.parse(j.stdout)).toMatchObject({
      ok: false,
      comment: 'failed',
      url: 'https://feat-add-thing-edge.acme.workers.dev',
    })
  })

  test('--comment without gh installed: the result still reaches stdout, exit 1', async () => {
    rmSync(join(fx.dir, '.fakebin/gh'))
    rmSync(join(fx.dir, 'node_modules/.bin/gh'))
    // A PATH with the fakes, bun and sh, but no gh.
    const PATH = [join(fx.dir, '.fakebin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':')
    const r = await fx.kit(['deploy', 'admin', '--preview', '--comment', '--json'], {
      env: { ...BRANCH, PATH },
    })
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      comment: 'failed',
      url: 'https://feat-add-thing-edge.acme.workers.dev',
    })
  })

  test('a custom deploy previews after the target build; without one, or with deploy: false, exit 2', async () => {
    const withEdge = (edge: string) =>
      writeFileSync(
        join(fx.dir, 'kit.config.ts'),
        CONFIG.replace(
          /edge: \{ kind: 'worker'[^\n]*\n/,
          `edge: { kind: 'worker', dir: 'apps/edge', ${edge} },\n`,
        ),
      )
    withEdge("deploy: ['bun run build', 'wrangler deploy']")
    const none = await fx.kit(['deploy', 'edge', '--preview'], { env: BRANCH })
    expect(none.code).toBe(2)
    expect(none.stderr).toContain('A preview of "edge" needs targets.edge.build')
    withEdge('deploy: false')
    const off = await fx.kit(['deploy', 'edge', '--preview'], { env: BRANCH })
    expect(off.code).toBe(2)
    expect(off.stderr).toContain('not deployable')
    expect(fx.calls()).toEqual([])
    withEdge("build: 'touch built.txt', deploy: ['bun run build', 'wrangler deploy']")
    const r = await fx.kit(['deploy', 'edge', '--preview'], { env: BRANCH })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('https://feat-add-thing-edge.acme.workers.dev\n')
    expect(existsSync(join(fx.dir, 'apps/edge/built.txt'))).toBe(true)
    expect(summary()).toEqual(['./apps/edge wrangler versions upload --preview-alias feat-add-thing'])
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
        {
          body: `${previewMarker('edge')}\nold`,
          url: 'https://github.com/o/r/pull/12#issuecomment-2',
          viewerDidAuthor: true,
        },
        {
          body: `${previewMarker('admin')}\nold`,
          url: 'https://github.com/o/r/pull/12#issuecomment-987',
          viewerDidAuthor: true,
        },
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

describe('deploy --preview --comment', () => {
  test("a person's comment carrying the marker is left alone: kit creates its own", async () => {
    const pr = {
      number: 12,
      comments: [
        // Someone else pasted kit's comment; the gh user quoted the marker mid-comment.
        {
          body: `${previewMarker('admin')}\nmine now`,
          url: 'https://github.com/o/r/pull/12#issuecomment-5',
          viewerDidAuthor: false,
        },
        {
          body: `see ${previewMarker('admin')}`,
          url: 'https://github.com/o/r/pull/12#issuecomment-6',
          viewerDidAuthor: true,
        },
      ],
    }
    writeFileSync(join(fx.dir, '.pr.json'), JSON.stringify(pr))
    fx.script(
      'gh',
      `printf '%s\\n' "$(bun -e 'console.log(JSON.stringify({bin:process.argv[1],argv:process.argv.slice(2),cwd:process.cwd()}))' gh "$@")" >> "${join(fx.dir, '.calls.log')}"
if [ "$2" = view ]; then cat "${fx.dir}/.pr.json"; fi`,
    )
    const r = await fx.kit(['deploy', 'admin', '--preview', '--comment', '--json'], { env: BRANCH })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).comment).toBe('created')
    expect(fx.calls().at(-1)!.argv.slice(0, 3)).toEqual(['pr', 'comment', '12'])
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

  // Newest last: code A, code B (live), then two secret pushes on top of B.
  const dep = (version: string, day: number, secret = false) => ({
    id: `dep-${day}`,
    created_on: `2026-03-0${day}T10:00:00.000Z`,
    annotations: secret ? { 'workers/triggered_by': 'secret' } : {},
    versions: [{ version_id: version, percentage: 100 }],
  })
  const listings = (deployments: unknown[], versions: unknown[] = []) => {
    writeFileSync(join(fx.dir, '.deployments.json'), JSON.stringify(deployments))
    writeFileSync(join(fx.dir, '.versions.json'), JSON.stringify(versions))
  }
  const LISTS = [
    './apps/edge wrangler deployments list --env staging --json',
    './apps/edge wrangler versions list --env staging --json',
  ]

  test('skips secret-only deployments: rolls back to the last different code, named in the confirm', async () => {
    // The first secret push is marked on the deployment, the second only on its version.
    listings(
      [dep('code-a', 1), dep('code-b', 2), dep('secret-1', 3, true), dep('secret-2', 4)],
      [{ id: 'secret-2', annotations: { 'workers/triggered_by': 'secret' } }],
    )
    const ask = await fx.kit(['release', 'rollback', 'edge'])
    expect(ask.code).toBe(2)
    expect(summary()).toEqual(LISTS)
    const r = await fx.kit(['release', 'rollback', 'edge', '--yes', '--json'], {
      env: { CLOUDFLARE_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(r.code).toBe(0)
    expect(summary().slice(2)).toEqual([
      ...LISTS,
      './apps/edge wrangler rollback code-a --env staging --message kit release rollback edge',
    ])
    expect(new Set(accounts())).toEqual(new Set([EDGE_ID]))
    expect(JSON.parse(r.stdout)).toMatchObject({
      to: 'code-a',
      deployed: '2026-03-01T10:00:00.000Z',
      secretChanges: 2,
      ok: true,
    })
    expect(r.stderr).toContain('2 secret changes since then revert with it; run `kit env push` afterwards')
  })

  test('no earlier code version, or no listing: exit 4 and no rollback', async () => {
    listings([dep('code-b', 2), dep('secret-1', 3, true)])
    const r = await fx.kit(['release', 'rollback', 'edge', '--yes'])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('No earlier code version of edge')
    expect(summary()).toEqual(LISTS)
    fx.fail('wrangler', 1, 'Authentication error')
    expect((await fx.kit(['release', 'rollback', 'edge', '--yes'])).code).toBe(4)
    expect(summary().some((c) => c.includes('wrangler rollback'))).toBe(false)
  })

  test('wrangler gets no terminal on stdin, so it takes its defaults instead of prompting', async () => {
    fx.script('wrangler', 'if [ -t 0 ]; then echo tty; exit 9; fi; cat; echo done')
    const r = await fx.kit(['release', 'rollback', 'edge', '--to', VERSION, '--yes'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('done')
  })

  test('--to names the version; tags stay and the stale one is named', async () => {
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('tag', 'edge/v1.2.3')
    const r = await fx.kit(['release', 'rollback', 'edge', '--to', VERSION, '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(fx.calls().map((c) => c.argv)).toEqual([
      ['rollback', VERSION, '--env', 'staging', '--message', 'kit release rollback edge'],
    ])
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
    expect(r.stderr).toContain('apps/edge $ bun x wrangler rollback <previous code version> --env staging')
    expect(fx.calls()).toEqual([])
  })

  test('a failed rollback exits 1', async () => {
    fx.fail('wrangler', 1, 'nope')
    expect((await fx.kit(['release', 'rollback', 'edge', '--to', VERSION, '--yes'])).code).toBe(1)
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

  test('a service cannot be named after a kit release command (config error)', async () => {
    writeFileSync(
      join(fx.dir, 'kit.config.ts'),
      CONFIG.replace('/*ROLLBACK*/', "rollback: { versionKey: 'rollback', deploy: 'kit deploy edge' },"),
    )
    const r = await fx.kit(['release', 'rollback', 'edge', '--dry-run'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('"rollback" is a kit release command; rename the service')
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
    const json = await fx.kit(['logs', 'admin', '--json'])
    expect(json.code).toBe(2)
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      hint: 'For JSON lines: kit logs admin -- --format json',
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

  test('backup warns when git does not ignore the dump; quiet once backups/ is ignored', async () => {
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: fx.dir })
    git('init', '-q')
    const loud = await fx.kit(['db', 'backup', '--db', 'db'])
    expect(loud.code).toBe(0)
    expect(loud.stderr).toContain('is not ignored by git')
    writeFileSync(join(fx.dir, '.gitignore'), 'backups/\n')
    const quiet = await fx.kit(['db', 'backup', '--db', 'db'])
    expect(quiet.code).toBe(0)
    expect(quiet.stderr).not.toContain('not ignored')
  })

  describe('restore', () => {
    const mine = () => localD1Files(join(fx.dir, 'apps/edge'), 'DB')
    beforeEach(() => {
      writeFileSync(join(fx.dir, 'dump.sql'), 'CREATE TABLE t (id);\n')
      mkdirSync(dirname(mine()[0]!), { recursive: true })
      for (const f of mine()) writeFileSync(f, 'old')
    })
    const EXEC = './apps/edge wrangler d1 execute infra-db'

    test('usage: a missing file, no file', async () => {
      expect((await fx.kit(['db', 'restore', 'nope.sql', '--db', 'db'])).code).toBe(2)
      expect((await fx.kit(['db', 'restore', '--db', 'db'])).code).toBe(2)
      expect(fx.calls()).toEqual([])
    })

    test('local: confirms, deletes the local database, then runs the file', async () => {
      expect((await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db'])).code).toBe(2)
      expect(readFileSync(mine()[0]!, 'utf8')).toBe('old')
      const dry = await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--dry-run'])
      expect(dry.code).toBe(0)
      expect(readFileSync(mine()[0]!, 'utf8')).toBe('old')
      expect(fx.calls()).toEqual([])
      const r = await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--yes'])
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('removed local infra-db')
      expect(summary()).toEqual([`${EXEC} --local --file <root>/dump.sql`])
      // The old file and its WAL sidecars are gone; wrangler wrote a new, empty one.
      expect(readFileSync(mine()[0]!, 'utf8')).toBe('')
      expect(existsSync(mine()[1]!)).toBe(false)
    })

    test('local: an unrecognised layout stops before anything is deleted or run', async () => {
      mkdirSync(join(fx.dir, 'apps/edge/.wrangler/state/v4'))
      const r = await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('Local D1 layout not recognised: apps/edge/.wrangler/state holds v4')
      expect(readFileSync(mine()[0]!, 'utf8')).toBe('old')
      expect(fx.calls()).toEqual([])
    })

    test('remote: an empty database is restored after a confirm', async () => {
      const TABLES = `${EXEC} --remote --command SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name --json`
      writeFileSync(
        join(fx.dir, '.tables.json'),
        JSON.stringify([{ results: [{ name: 'sqlite_sequence' }, { name: '_cf_KV' }], success: true }]),
      )
      expect((await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--remote'])).code).toBe(2)
      expect(summary()).toEqual([TABLES])
      expect((await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--remote', '--yes'])).code).toBe(0)
      expect(summary().slice(1)).toEqual([TABLES, `${EXEC} --remote --file <root>/dump.sql`])
      // The local database is not touched by a remote restore.
      expect(readFileSync(mine()[0]!, 'utf8')).toBe('old')
    })

    test('remote: a database with tables exits 4 naming them; nothing is dropped or run', async () => {
      writeFileSync(
        join(fx.dir, '.tables.json'),
        JSON.stringify([{ results: [{ name: 'd1_migrations' }, { name: 'users' }], success: true }]),
      )
      const r = await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--remote', '--yes'])
      expect(r.code).toBe(4)
      expect(r.stderr).toContain('Remote infra-db is not empty: d1_migrations, users')
      expect(fx.calls()).toHaveLength(1)
      writeFileSync(join(fx.dir, '.tables.json'), 'not json')
      expect((await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--remote', '--yes'])).code).toBe(4)
      expect(summary().some((c) => c.includes('--file'))).toBe(false)
    })

    test('remote --dry-run runs nothing', async () => {
      expect((await fx.kit(['db', 'restore', 'dump.sql', '--db', 'db', '--remote', '--dry-run'])).code).toBe(
        0,
      )
      expect(fx.calls()).toEqual([])
    })
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
      // The old files are gone; the migrate wrote a new, empty database in the same place.
      expect(readFileSync(mine()[0]!, 'utf8')).toBe('')
      expect(existsSync(mine()[1]!)).toBe(false)
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

    test('a state version dir other than v3: exit 1 up front, nothing deleted', async () => {
      mkdirSync(join(fx.dir, 'apps/edge/.wrangler/state/v4'))
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(
        'Local D1 layout not recognised: apps/edge/.wrangler/state holds v4, kit knows v3',
      )
      expect(mine().every((f) => existsSync(f))).toBe(true)
      expect(fx.calls()).toEqual([])
    })

    test('wrangler writes the database somewhere else: exit 1 after migrating, no seed, no success', async () => {
      rmSync(join(fx.dir, 'apps/edge/.wrangler'), { recursive: true })
      writeFileSync(join(fx.dir, '.no-d1-file'), '')
      const r = await fx.kit(['db', 'reset', '--db', 'db', '--yes'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('Local D1 layout not recognised: wrangler did not write infra-db to')
      expect(r.stderr).not.toContain('reset local infra-db')
      expect(summary()).toEqual(['./apps/edge wrangler d1 migrations apply infra-db --local'])
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
