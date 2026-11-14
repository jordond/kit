import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

const ISSUER = '69a6de70-03db-47e3-e053-5b8c7c11a4d1'
const KEY_ID = 'ABC123DEFG'
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

// A stand-in App Store Connect: records the bearer token and answers with `status`.
let server: ReturnType<typeof Bun.serve>
let status = 200
let tokens: string[] = []
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      tokens.push((req.headers.get('authorization') ?? '').replace(/^Bearer /, ''))
      return new Response('{}', { status })
    },
  })
})
afterAll(() => server.stop(true))

let fx: Fixture
let matchUrl = ''
beforeEach(() => {
  status = 200
  tokens = []
  fx = fixture('release', ['gh'])
  writeFileSync(join(fx.dir, `AuthKey_${KEY_ID}.p8`), P8)
  matchUrl = join(fx.dir, 'match.git')
  expect(Bun.spawnSync(['git', 'init', '-q', '--bare', matchUrl]).exitCode).toBe(0)
})
afterEach(() => fx.cleanup())

const read = (p: string) => readFileSync(join(fx.dir, p), 'utf8')
const envValue = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(read('.env'))?.[1] ?? ''
/** Nothing inherited from the machine running the tests. */
const clean = {
  ASC_KEY_ID: '',
  ASC_ISSUER_ID: '',
  ASC_KEY_P8_BASE64: '',
  MATCH_GIT_URL: '',
  MATCH_PASSWORD: '',
  MATCH_GIT_BASIC_AUTHORIZATION: '',
}
const run = (args: string[], env: Record<string, string> = {}) =>
  fx.kit(['release', 'setup', 'ios', ...args], {
    env: { ...clean, KIT_ASC_API_URL: `http://localhost:${server.port}`, ...env },
  })
const flags = () => ['--p8', `AuthKey_${KEY_ID}.p8`, '--issuer-id', ISSUER, '--match-url', matchUrl]

describe('release setup ios', () => {
  test('checks the key and the match repo, then writes the secrets without printing them', async () => {
    writeFileSync(join(fx.dir, '.env'), '# app\nOTHER=1\n')
    const r = await run(flags(), { MATCH_PASSWORD: 'match-pass-value' })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(read('.env')).toStartWith('# app\nOTHER=1\n')
    expect(envValue('ASC_KEY_ID')).toBe(KEY_ID) // from the file name
    expect(envValue('ASC_ISSUER_ID')).toBe(ISSUER)
    expect(Buffer.from(envValue('ASC_KEY_P8_BASE64'), 'base64').toString()).toBe(P8)
    expect(envValue('MATCH_GIT_URL')).toBe(matchUrl)
    expect(envValue('MATCH_PASSWORD')).toBe('match-pass-value')
    expect(read('.env')).not.toContain('MATCH_GIT_BASIC_AUTHORIZATION')

    expect(r.stderr).toContain('App Store Connect accepted the API key')
    expect(r.stderr).toContain('match repo is readable')
    expect(r.stderr).toContain('MATCH_GIT_BASIC_AUTHORIZATION not set')
    expect(r.stderr).toContain('kit release certs --add')
    expect(r.stderr).not.toContain('match-pass-value')
    expect(r.stderr).not.toContain(envValue('ASC_KEY_P8_BASE64'))
    expect(fx.calls()).toEqual([])

    // The request carried a token signed by the .p8, for that key id and issuer.
    const [head, body, signature] = tokens[0]!.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: KEY_ID,
      typ: 'JWT',
    })
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toMatchObject({
      iss: ISSUER,
      aud: 'appstoreconnect-v1',
    })
    const valid = verify(
      'sha256',
      Buffer.from(`${head}.${body}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    )
    expect(valid).toBe(true)
  })

  test('a key App Store Connect rejects is not stored', async () => {
    status = 401
    const r = await run(flags(), { MATCH_PASSWORD: 'match-pass-value' })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('App Store Connect rejected the API key (HTTP 401)')
    expect(existsSync(join(fx.dir, '.env'))).toBe(false)
  })

  test('a second run keeps .env and --github pushes what it holds, basic authorization included', async () => {
    expect((await run(flags(), { MATCH_PASSWORD: 'match-pass-value' })).code).toBe(0)
    const before = read('.env')
    const r = await run(['--github', '--no-verify'], { MATCH_GIT_BASIC_AUTHORIZATION: 'dXNlcjp0b2tlbg==' })
    expect(r.code).toBe(0)
    expect(tokens).toHaveLength(1) // --no-verify: no second request
    expect(read('.env')).toBe(`${before}MATCH_GIT_BASIC_AUTHORIZATION=dXNlcjp0b2tlbg==\n`)
    expect(r.stderr).toContain('wrote MATCH_GIT_BASIC_AUTHORIZATION to .env')
    expect(fx.calls().map((c) => c.argv.join(' '))).toEqual([
      'secret set ASC_KEY_ID',
      'secret set ASC_ISSUER_ID',
      'secret set ASC_KEY_P8_BASE64',
      'secret set MATCH_GIT_URL',
      'secret set MATCH_PASSWORD',
      'secret set MATCH_GIT_BASIC_AUTHORIZATION',
    ])
  })

  test('without a terminal, names what is missing and writes nothing', async () => {
    const r = await run(['--p8', `AuthKey_${KEY_ID}.p8`])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Missing ASC_ISSUER_ID, MATCH_GIT_URL, MATCH_PASSWORD')
    expect(existsSync(join(fx.dir, '.env'))).toBe(false)
    expect(tokens).toEqual([])
  })

  test('rejects a file that is not a .p8, and a malformed issuer id', async () => {
    writeFileSync(join(fx.dir, 'notes.p8'), 'hello')
    const file = await run(['--p8', 'notes.p8'])
    expect(file.code).toBe(2)
    expect(file.stderr).toContain('is not a .p8 private key')

    const issuer = await run(['--p8', `AuthKey_${KEY_ID}.p8`, '--issuer-id', 'nope', '--match-url', matchUrl])
    expect(issuer.code).toBe(2)
    expect(issuer.stderr).toContain('"nope" is not an issuer id')
  })

  test('an unreadable match repo is a warning; --dry-run --json plans without writing', async () => {
    const args = [...flags().slice(0, 4), '--match-url', join(fx.dir, 'nowhere.git')]
    const dry = await run([...args, '--dry-run', '--json'], { MATCH_PASSWORD: 'match-pass-value' })
    expect(dry.code).toBe(0)
    expect(JSON.parse(dry.stdout)).toEqual({
      env: ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_BASE64', 'MATCH_GIT_URL', 'MATCH_PASSWORD'],
      github: null,
      verified: { asc: 'ok', match: 'unreachable' },
      dryRun: true,
    })
    expect(existsSync(join(fx.dir, '.env'))).toBe(false)

    const r = await run(args, { MATCH_PASSWORD: 'match-pass-value' })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('this machine cannot read the match repo')
    expect(envValue('MATCH_PASSWORD')).toBe('match-pass-value')
  })

  test('needs release.ios', async () => {
    fx.cleanup()
    fx = fixture('release-toolchain', [])
    const r = await run([])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('No release.ios in kit.config.ts')
  })
})
