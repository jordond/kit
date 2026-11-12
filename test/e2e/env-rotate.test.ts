import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const KIT = resolve(import.meta.dir, '../..')
const OLD = 's3cr3t-value-0123456789'
const TOKEN = 'ghp_token_value_xyz'
let fx: Fixture

/** The default fake, plus anything piped to `secret put` / `secret set`. */
function recordingFake(bin: string): string {
  const log = join(fx.dir, '.calls.log')
  return `printf '%s\\n' "$(bun -e 'console.log(JSON.stringify({bin:process.argv[1],argv:process.argv.slice(2),cwd:process.cwd()}))' "${bin}" "$@")" >> "${log}"
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
/** The value `.env` holds for API_SECRET (the fixture marks it `generate: 'hex'`). */
const apiSecret = () => /^API_SECRET=(.*)$/m.exec(read('.env'))?.[1] ?? ''

describe('env rotate', () => {
  test('--yes rewrites only that .env line, re-renders outputs, and never prints the value', async () => {
    writeFileSync(
      join(fx.dir, '.env'),
      `# master env\nAPI_SECRET="${OLD}"\nPUBLIC_URL=https://edge.example.com\n\n# ci\nDEPLOY_TOKEN=${TOKEN}\n`,
    )
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--yes'])
    expect(r.code).toBe(0)
    const value = /^API_SECRET="(.*)"$/m.exec(read('.env'))?.[1] ?? ''
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    expect(read('.env')).toBe(
      `# master env\nAPI_SECRET="${value}"\nPUBLIC_URL=https://edge.example.com\n\n# ci\nDEPLOY_TOKEN=${TOKEN}\n`,
    )
    expect(read('apps/edge/.dev.vars')).toContain(`API_SECRET=${value}\n`)
    expect(read('apps/admin/.dev.vars')).toContain(`X_INTERNAL_SECRET=${value}\n`)
    expect(r.stdout).toBe('')
    expect(r.stderr).not.toContain(value)
    expect(r.stderr).not.toContain(OLD)
    expect(r.stderr).toContain('API_SECRET  → edge, admin')
    expect(r.stderr).toContain('rotated API_SECRET in .env')
    expect(r.stderr).toContain('wrote apps/edge/.dev.vars')
    expect(r.stderr).toContain('not pushed yet; push the new value with: kit env push --workers')
    expect(fx.calls()).toEqual([])
  })

  test('--json reports keys and destinations, no values', async () => {
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--yes', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      dryRun: false,
      rotated: [{ key: 'API_SECRET', destinations: ['edge', 'admin'] }],
      outputs: ['apps/edge/.dev.vars', 'apps/admin/.dev.vars'],
      push: ['kit env push --workers'],
      pushed: false,
      pending: 'kit env push --workers',
    })
    expect(r.stderr).toContain('not pushed yet; push the new value with: kit env push --workers')
    expect(apiSecret()).toMatch(/^[0-9a-f]{64}$/)
    expect(r.stdout + r.stderr).not.toContain(apiSecret())
  })

  test('--push pushes the new value to the workers that hold the key, GitHub untouched', async () => {
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--push', '--yes', '--json'])
    expect(r.code).toBe(0)
    const value = apiSecret()
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    expect(summary()).toEqual([
      './apps/edge wrangler secret list --format json',
      './apps/admin wrangler secret list --format json',
      './apps/edge wrangler secret put API_SECRET',
      './apps/admin wrangler secret put API_SECRET',
    ])
    expect(stdinLog()).toBe(`${value}\n\n${value}\n\n`)
    const doc = JSON.parse(r.stdout)
    expect(doc.pushed).toBe(true)
    expect(doc.outcomes).toEqual([
      { destination: 'edge', key: 'API_SECRET', status: 'pushed' },
      { destination: 'edge', key: 'OPTIONAL_KEY', status: 'skipped-empty' },
      { destination: 'admin', key: 'API_SECRET', status: 'pushed' },
    ])
    expect(r.stdout + r.stderr).not.toContain(value)
  })

  test('--push: a failed put exits 1, pushed false, the value redacted from child output', async () => {
    fx.script(
      'wrangler',
      `${recordingFake('wrangler').replace(/\necho "wrangler ok"$/, '')}
if [ "$2" = put ]; then echo "rejected $(tail -n 2 "${fx.dir}/.stdin.log" | head -n 1)" >&2; exit 1; fi
echo "wrangler ok"`,
    )
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--push', '--yes'])
    expect(r.code).toBe(1)
    const value = apiSecret()
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    expect(r.stderr).toContain('push API_SECRET → edge failed')
    expect(r.stderr).toContain('rejected ***')
    expect(r.stderr).toContain('run: kit env push --workers')
    // Under --json the note still reaches stderr and the document carries what is left to do.
    const j = await fx.kit(['env', 'rotate', 'API_SECRET', '--push', '--yes', '--json'])
    expect(j.code).toBe(1)
    expect(j.stderr).toContain('.env holds the new value but the push did not finish')
    expect(JSON.parse(j.stdout)).toMatchObject({ pushed: false, pending: 'kit env push --workers' })
    expect(j.stdout + j.stderr).not.toContain(apiSecret())
    expect(r.stdout + r.stderr).not.toContain(value)
  })

  test('--push: a remote that cannot be listed stops the run before .env changes', async () => {
    fx.script(
      'wrangler',
      `${recordingFake('wrangler').replace(/\necho "wrangler ok"$/, '')}
if [ "$2" = list ]; then echo "not authenticated" >&2; exit 1; fi
echo "wrangler ok"`,
    )
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--push'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('could not list secrets on edge, admin; nothing was rotated')
    expect(apiSecret()).toBe(OLD)
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(false)
    expect(summary().some((c) => c.includes('secret put'))).toBe(false)
    // --yes does not turn the listing into a formality: same refusal, .env untouched.
    const y = await fx.kit(['env', 'rotate', 'API_SECRET', '--push', '--yes', '--json'])
    expect(y.code).toBe(1)
    expect(JSON.parse(y.stdout)).toMatchObject({ ok: false })
    expect(y.stdout).toContain('nothing was rotated')
    expect(apiSecret()).toBe(OLD)
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(false)
    expect(summary().some((c) => c.includes('secret put'))).toBe(false)
  })

  test('--push off a terminal asks once, after the listing and before anything is written', async () => {
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--push'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--yes')
    expect(summary()).toEqual([
      './apps/edge wrangler secret list --format json',
      './apps/admin wrangler secret list --format json',
    ])
    expect(apiSecret()).toBe(OLD)
  })

  test('a failed render says .env is rewritten and how to finish (exit 1)', async () => {
    mkdirSync(join(fx.dir, 'apps/edge/.dev.vars'), { recursive: true })
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--push', '--yes', '--json'])
    expect(r.code).toBe(1)
    const value = apiSecret()
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    expect(r.stderr).toContain('.env holds the new API_SECRET, but rendering outputs failed')
    expect(r.stderr).toContain('run: kit env sync && kit env push --workers')
    expect(JSON.parse(r.stdout)).toMatchObject({
      pushed: false,
      pending: 'kit env sync && kit env push --workers',
    })
    expect(summary().some((c) => c.includes('secret put'))).toBe(false)
    expect(r.stdout + r.stderr).not.toContain(value)
  })

  test('without --yes off a terminal: refuses to confirm (exit 2), nothing written', async () => {
    const r = await fx.kit(['env', 'rotate', 'API_SECRET'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--yes')
    expect(apiSecret()).toBe(OLD)
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(false)
    expect(fx.calls()).toEqual([])
  })

  test('--dry-run writes nothing and lists what would rotate and where it would be pushed', async () => {
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--push', '--dry-run'])
    expect(r.code).toBe(0)
    expect(apiSecret()).toBe(OLD)
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(false)
    expect(fx.calls()).toEqual([])
    expect(r.stderr).toContain('API_SECRET  → edge, admin')
    expect(r.stderr).toContain('would rotate API_SECRET in .env')
    expect(r.stderr).toContain('would push with: kit env push --workers')
    const j = await fx.kit(['env', 'rotate', 'API_SECRET', '--dry-run', '--json'])
    expect(JSON.parse(j.stdout)).toEqual({
      dryRun: true,
      rotated: [{ key: 'API_SECRET', destinations: ['edge', 'admin'] }],
      outputs: ['apps/edge/.dev.vars', 'apps/admin/.dev.vars'],
      push: ['kit env push --workers'],
      pushed: false,
    })
    expect(apiSecret()).toBe(OLD)
  })

  test('a key without `generate` is a usage error pointing at the provider', async () => {
    const r = await fx.kit(['env', 'rotate', 'DEPLOY_TOKEN', '--yes'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('DEPLOY_TOKEN is not rotatable')
    expect(r.stderr).toContain('Rotate third-party keys at the provider')
    expect(r.stderr).toContain('kit env push')
    expect(read('.env')).toContain(`DEPLOY_TOKEN=${TOKEN}`)
    // One bad key stops the whole run: the rotatable one is left alone too.
    expect((await fx.kit(['env', 'rotate', 'API_SECRET', 'DEPLOY_TOKEN', '--yes'])).code).toBe(2)
    expect(apiSecret()).toBe(OLD)
  })

  test('an unknown key suggests the nearest; no key at all is a usage error', async () => {
    const r = await fx.kit(['env', 'rotate', 'API_SECRT', '--yes'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Unknown env key "API_SECRT"')
    expect(r.stderr).toContain('Did you mean API_SECRET?')
    expect((await fx.kit(['env', 'rotate', '--yes'])).code).toBe(2)
    expect(apiSecret()).toBe(OLD)
  })

  test('a generated value its schema rejects fails before anything is written (exit 3)', async () => {
    writeFileSync(
      join(fx.dir, '.kit/env.ts'),
      read('.kit/env.ts').replace('z.string().min(16)', 'z.string().min(16).max(30)'),
    )
    const r = await fx.kit(['env', 'rotate', 'API_SECRET', '--yes'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('API_SECRET fails its schema')
    expect(apiSecret()).toBe(OLD)
    expect(existsSync(join(fx.dir, 'apps/edge/.dev.vars'))).toBe(false)
  })

  test('a key .env lacks is added; one held by a worker and GitHub pushes to both', async () => {
    writeFileSync(
      join(fx.dir, '.kit/env.ts'),
      read('.kit/env.ts').replace(
        'OPTIONAL_KEY: z.string().optional()',
        "OPTIONAL_KEY: z.string().meta({ generate: 'base64url', length: 24 }).optional()",
      ),
    )
    writeFileSync(
      join(fx.dir, 'kit.config.ts'),
      read('kit.config.ts').replace(
        "githubSecrets: ['DEPLOY_TOKEN']",
        "githubSecrets: ['DEPLOY_TOKEN', 'OPTIONAL_KEY']",
      ),
    )
    const r = await fx.kit(['env', 'rotate', 'OPTIONAL_KEY', '--push', '--yes'])
    expect(r.code).toBe(0)
    const value = /^OPTIONAL_KEY=(.*)$/m.exec(read('.env'))?.[1] ?? ''
    expect(value).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(read('.env')).toBe(
      `API_SECRET=${OLD}\nPUBLIC_URL=https://edge.example.com\nDEPLOY_TOKEN=${TOKEN}\nOPTIONAL_KEY=${value}\n`,
    )
    expect(read('apps/edge/.dev.vars')).toContain(`OPTIONAL_KEY=${value}\n`)
    expect(r.stderr).toContain('OPTIONAL_KEY  → edge, github')
    expect(summary()).toEqual([
      './apps/edge wrangler secret list --format json',
      '. gh secret list --json name',
      './apps/edge wrangler secret put API_SECRET',
      './apps/edge wrangler secret put OPTIONAL_KEY',
      '. gh secret set DEPLOY_TOKEN',
      '. gh secret set OPTIONAL_KEY',
    ])
    expect(stdinLog()).toBe(`${OLD}\n\n${value}\n\n${TOKEN}\n${value}\n`)
    expect(r.stdout + r.stderr).not.toContain(value)
  })
})
