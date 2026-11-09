import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const KIT = resolve(import.meta.dir, '../..')
const SECRET = 's3cr3t-value-0123456789'
const TOKEN = 'ghp_token_value_xyz'
const EDGE_ID = '0123456789abcdef0123456789abcdef'
let fx: Fixture

/** Like the default fake, plus the account id it saw and anything piped to `secret put` / `secret set`. */
function recordingFake(bin: string): string {
  const log = join(fx.dir, '.calls.log')
  return `printf '%s\\n' "$(bun -e 'console.log(JSON.stringify({bin:process.argv[1],argv:process.argv.slice(2),cwd:process.cwd()}))' "${bin}" "$@")" >> "${log}"
echo "$CLOUDFLARE_ACCOUNT_ID" >> "${fx.dir}/.account.log"
if [ "$1" = secret ] && { [ "$2" = put ] || [ "$2" = set ]; }; then cat >> "${fx.dir}/.stdin.log"; echo >> "${fx.dir}/.stdin.log"; fi
f="${fx.dir}/.fakebin/${bin}.fail"
if [ -f "$f" ] && [ "$2" != list ]; then cat "$f.out" 2>/dev/null; exit "$(cat "$f")"; fi
echo "${bin} ok"`
}

beforeEach(() => {
  fx = fixture('infra', ['wrangler', 'gh'])
  // The repo's env schema imports its own zod.
  symlinkSync(join(KIT, 'node_modules/zod'), join(fx.dir, 'node_modules/zod'))
  fx.script('wrangler', recordingFake('wrangler'))
  fx.script('gh', recordingFake('gh'))
})
afterEach(() => fx.cleanup())

const summary = () => fx.calls().map((c) => `${c.cwd} ${c.bin} ${c.argv.join(' ')}`)
const read = (p: string) => readFileSync(join(fx.dir, p), 'utf8')
const stdinLog = () => (existsSync(join(fx.dir, '.stdin.log')) ? read('.stdin.log') : '')

describe('env sync / check', () => {
  test('sync writes outputs and names keys, never values', async () => {
    const r = await fx.kit(['env', 'sync'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('wrote apps/edge/.dev.vars  +API_SECRET +PUBLIC_URL +OPTIONAL_KEY')
    expect(r.stderr).not.toContain(SECRET)
    expect(read('apps/edge/.dev.vars')).toContain(
      `API_SECRET=${SECRET}\nPUBLIC_URL=https://edge.example.com\n# OPTIONAL_KEY=\n`,
    )
    expect(read('apps/admin/.dev.vars')).toContain(`X_INTERNAL_SECRET=${SECRET}\n`)
  })

  test('check: drift exits 3, clean after sync', async () => {
    const before = await fx.kit(['env', 'check'])
    expect(before.code).toBe(3)
    expect(before.stderr).toContain('apps/edge/.dev.vars missing')
    await fx.kit(['env', 'sync'])
    const after = await fx.kit(['env', 'check', '--json'])
    expect(after.code).toBe(0)
    expect(JSON.parse(after.stdout)).toEqual({ ok: true, invalid: [], drift: [] })
  })

  test('check: invalid env exits 3 naming the key', async () => {
    const r = await fx.kit(['env', 'check', '--schema-only'], { env: { PUBLIC_URL: 'not a url' } })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('PUBLIC_URL')
  })

  test('sync refuses an invalid env with exit 3 and writes nothing', async () => {
    const r = await fx.kit(['env', 'sync'], { env: { API_SECRET: 'short' } })
    expect(r.code).toBe(3)
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(false)
  })
})

describe('env push', () => {
  test('without --yes off a terminal: lists, then refuses to confirm (exit 2)', async () => {
    const r = await fx.kit(['env', 'push'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--yes')
    expect(summary().some((s) => s.includes('secret put'))).toBe(false)
  })

  test('--yes pushes each worker secret via stdin from the target dir, account pinned', async () => {
    const r = await fx.kit(['env', 'push', '--yes'], {
      env: { CLOUDFLARE_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(r.code).toBe(0)
    expect(summary()).toEqual([
      './apps/edge wrangler secret list --format json',
      './apps/admin wrangler secret list --format json',
      './apps/edge wrangler secret put API_SECRET',
      './apps/admin wrangler secret put API_SECRET',
    ])
    expect(stdinLog()).toBe(`${SECRET}\n\n${SECRET}\n\n`)
    expect(new Set(read('.account.log').trim().split('\n'))).toEqual(new Set([EDGE_ID]))
    expect(r.stderr).toContain('OPTIONAL_KEY  skipped-empty')
    expect(r.stderr + r.stdout).not.toContain(SECRET)
  })

  test('--target limits to one worker; unknown target is a usage error', async () => {
    expect((await fx.kit(['env', 'push', '--target', 'admin', '--yes'])).code).toBe(0)
    expect(summary()).toEqual([
      './apps/admin wrangler secret list --format json',
      './apps/admin wrangler secret put API_SECRET',
    ])
    expect((await fx.kit(['env', 'push', '--target', 'nope', '--yes'])).code).toBe(2)
  })

  test('--github pushes with gh from the root', async () => {
    const r = await fx.kit(['env', 'push', '--github', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['. gh secret list --json name', '. gh secret set DEPLOY_TOKEN'])
    expect(stdinLog()).toBe(`${TOKEN}\n`)
    expect(JSON.parse(r.stdout).outcomes).toEqual([
      { destination: 'github', key: 'DEPLOY_TOKEN', status: 'pushed' },
    ])
  })

  test('--dry-run lists but pushes nothing', async () => {
    const r = await fx.kit(['env', 'push', '--dry-run'])
    expect(r.code).toBe(0)
    expect(summary().every((s) => s.includes('secret list'))).toBe(true)
    expect(r.stderr).toContain('API_SECRET  new')
  })

  test('a failed put exits 1 and redacts the value from wrangler output', async () => {
    fx.fail('wrangler', 1, `Authentication error while setting ${SECRET}`)
    const r = await fx.kit(['env', 'push', '--yes'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('push API_SECRET → edge failed')
    expect(r.stderr).toContain('Authentication error while setting ***')
    expect(r.stderr).not.toContain(SECRET)
    expect(summary().filter((s) => s.includes('secret put'))).toHaveLength(1)
  })
})

describe('env init', () => {
  test('--dry-run reports what it would ask for', async () => {
    rmSync(join(fx.dir, '.env'))
    const r = await fx.kit(['env', 'init', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ dryRun: true, created: true, backfilled: [], ask: ['API_SECRET'] })
    expect(existsSync(join(fx.dir, '.env'))).toBe(false)
  })

  test('off a terminal it never prompts (exit 2)', async () => {
    rmSync(join(fx.dir, '.env'))
    const r = await fx.kit(['env', 'init'])
    expect(r.code).toBe(2)
    expect(existsSync(join(fx.dir, '.env'))).toBe(false)
  })

  test('complete .env: backfills from the example and renders outputs', async () => {
    const r = await fx.kit(['env', 'init'])
    expect(r.code).toBe(0)
    expect(read('.env')).toContain('OPTIONAL_KEY=')
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(true)
  })
})

describe('db', () => {
  test('several databases and no --db: usage error listing them', async () => {
    const r = await fx.kit(['db', 'migrate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Databases: db (infra-db), analytics (infra-analytics)')
    expect(fx.calls()).toEqual([])
  })

  test('migrate runs wrangler from the database target dir, local by default, account pinned', async () => {
    const r = await fx.kit(['db', 'migrate', '--db', 'db'], {
      env: { CLOUDFLARE_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    })
    expect(r.code).toBe(0)
    expect(summary()).toEqual(['./apps/edge wrangler d1 migrations apply infra-db --local'])
    expect(read('.account.log').trim()).toBe(EDGE_ID)
  })

  test('remote mutations confirm: exit 2 without --yes, run with it', async () => {
    expect((await fx.kit(['db', 'migrate', '--db', 'analytics', '--remote'])).code).toBe(2)
    expect(fx.calls()).toEqual([])
    expect((await fx.kit(['db', 'migrate', '--db', 'analytics', '--remote', '--yes'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/analytics wrangler d1 migrations apply infra-analytics --remote'])
  })

  test('list is read-only: --remote needs no confirmation', async () => {
    expect((await fx.kit(['db', 'list', '--db', 'infra-db', '--remote'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/edge wrangler d1 migrations list infra-db --remote'])
  })

  test('create and exec --dry-run run nothing', async () => {
    const c = await fx.kit(['db', 'create', 'add_users', '--db', 'db', '--dry-run'])
    expect(c.code).toBe(0)
    expect(c.stderr).toContain('wrangler d1 migrations create infra-db add_users')
    const e = await fx.kit(['db', 'exec', 'SELECT 1', '--db', 'db', '--dry-run'])
    expect(e.code).toBe(0)
    expect(fx.calls()).toEqual([])
  })

  test('exec --json hands wrangler --json; a child failure exits 1', async () => {
    expect((await fx.kit(['db', 'exec', 'SELECT 1', '--db', 'db', '--json'])).code).toBe(0)
    expect(summary()).toEqual(['./apps/edge wrangler d1 execute infra-db --local --command SELECT 1 --json'])
    fx.fail('wrangler', 7)
    expect((await fx.kit(['db', 'exec', 'SELECT 1', '--db', 'db'])).code).toBe(1)
  })

  test('exec needs SQL or --file', async () => {
    expect((await fx.kit(['db', 'exec', '--db', 'db'])).code).toBe(2)
  })
})

test('help lists the infra groups', async () => {
  const r = await fx.kit(['--help'])
  expect(r.stdout + r.stderr).toContain('Render, check and push env from .env')
})
