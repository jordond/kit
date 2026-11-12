import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Check,
  checkAndroidVersion,
  checkCiPin,
  checkEnvFile,
  checkIosVersion,
  checkJava,
  checkLefthook,
  checkMise,
  checkReleaseSecrets,
  checkToolchain,
  checkWranglerLogin,
  checkXcode,
} from '../../src/commands/doctor'
import {
  androidVersionFix,
  applyFix,
  ciPinFix,
  describeFix,
  type Fix,
  fixable,
  iosVersionFix,
  pinVersion,
} from '../../src/lib/fix'

// `kit doctor --fix`: which checks carry a fix, and what each fix does (temp dirs, fakes on PATH).

let dir = ''
let path = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kit-fix-'))
  path = process.env.PATH ?? ''
})
afterEach(() => {
  process.env.PATH = path
  rmSync(dir, { recursive: true, force: true })
})

/** A fake `bin` first on PATH that appends `<cwd basename> <bin> <argv>` to calls.log. */
function fake(bin: string, body = '') {
  const bins = join(dir, '.fakebin')
  mkdirSync(bins, { recursive: true })
  writeFileSync(
    join(bins, bin),
    `#!/bin/sh\necho "$(basename "$PWD") ${bin} $*" >> "${join(dir, 'calls.log')}"\n${body}\n`,
  )
  chmodSync(join(bins, bin), 0o755)
  process.env.PATH = `${bins}:${path}`
}
const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
const here = () => dir.split('/').pop()!
const cmdOf = (c: Check) => (c.fix && 'cmd' in c.fix.action ? c.fix.action : undefined)

describe('which checks carry a fix', () => {
  test('lefthook: only the hook that is not installed in this clone', () => {
    expect(cmdOf(checkLefthook('lefthook.yml', true, undefined, false))).toEqual({
      cmd: ['lefthook', 'install'],
    })
    expect(checkLefthook('lefthook.yml', false, undefined, false).fix).toBeUndefined()
    expect(checkLefthook('lefthook.yml', true, 'lefthook run', false).fix).toBeUndefined()
  })

  test('mise: drift runs `mise install` and re-checks the tools it provides; no mise, no fix', () => {
    const drift = checkMise({ java: '21' }, { java: '17.0.1' })
    expect(drift.fix).toMatchObject({
      description: 'mise install',
      action: { cmd: ['mise', 'install'] },
      rechecks: ['java', 'ruby', 'ktlint'],
    })
    expect(checkMise({ java: '21' }, { java: '17.0.1' }, false).fix).toBeUndefined()
    expect(checkMise({ java: '21' }, { java: '21.0.2' }).fix).toBeUndefined()
  })

  test('wrangler: missing dependencies run the install; a login is never fixed', () => {
    const missing = checkWranglerLogin(undefined, { cmd: ['pnpm', 'install'], cwd: '.' })
    expect(missing.hint).toBe('Run `pnpm install`')
    expect(cmdOf(missing)).toEqual({ cmd: ['pnpm', 'install'], cwd: '.' })
    expect(checkWranglerLogin(undefined).hint).toBe('Run `bun install`')
    expect(checkWranglerLogin({ code: 1, output: 'You are not authenticated' }).fix).toBeUndefined()
  })

  test('toolchain wrapper: chmod +x when it cannot run; a missing wrapper is not fixed', () => {
    expect(cmdOf(checkToolchain('.', 'kotlin_cli_version=0.13.0', false))).toEqual({
      cmd: ['chmod', '+x', './kotlin'],
    })
    expect(checkToolchain('.', undefined, false).fix).toBeUndefined()
  })

  test('version drift: fixed from the TOML, unless the xcconfig has no MARKETING_VERSION line', () => {
    const fix = (d: { toml: string; file: string }): Fix => iosVersionFix(dir, d)
    const drift = { toml: '1.2.0', xcconfig: '1.1.0' as string | undefined, file: 'Config.xcconfig' }
    expect(checkIosVersion(() => drift, fix).fix?.description).toBe(
      'set MARKETING_VERSION = 1.2.0 in Config.xcconfig',
    )
    expect(checkIosVersion(() => ({ ...drift, xcconfig: undefined }), fix).fix).toBeUndefined()
    expect(checkIosVersion(() => undefined, fix).fix).toBeUndefined()
    expect(
      checkAndroidVersion(
        () => ({ toml: '1.2.0', module: '1.1.0', file: 'app/module.yaml' }),
        (d) => androidVersionFix(dir, d),
      ).fix?.description,
    ).toBe('set settings.android.versionName: "1.2.0" in app/module.yaml')
  })

  test('CI pin: fixed when the npm pin is a version', () => {
    const wf = [{ file: 'ci.yml', text: 'uses: jordond/kit/.github/actions/setup@abc # v1.0.0\n' }]
    const fix = (v: string) => (pinVersion(v) ? ciPinFix(dir, v) : undefined)
    expect(checkCiPin(wf, '^1.2.3', false, fix).fix?.description).toBe('move the workflow pins to v1.2.3')
    expect(checkCiPin(wf, '^1.0.0', false, fix).fix).toBeUndefined()
    expect(checkCiPin(wf, 'workspace:*', false, fix).fix).toBeUndefined()
    expect(pinVersion('~0.6.0')).toBe('0.6.0')
    expect(pinVersion('file:../kit')).toBeUndefined()
  })

  test('tools, .env and secrets are never fixed', () => {
    const never = [
      checkJava(undefined, true),
      checkXcode(undefined, true, 'darwin'),
      checkEnvFile('A=\n', undefined),
      checkEnvFile('A=\nB=\n', 'A=1\n'),
      checkReleaseSecrets({ required: ['ASC_KEY_ID'], ci: [], optional: [] }, {}, false),
    ]
    expect(never.every((c) => c.status !== 'ok')).toBe(true)
    expect(fixable(never)).toEqual([])
  })

  test('fixable keeps warnings and failures with a fix, in order', () => {
    const checks = [
      checkJava(undefined, true),
      checkLefthook('lefthook.yml', true, undefined, false),
      checkToolchain('.', 'x', false),
      { ...checkLefthook('lefthook.yml', true, undefined, false), status: 'ok' as const },
    ]
    expect(fixable(checks).map((c) => c.id)).toEqual(['lefthook', 'toolchain'])
  })

  test('describeFix: what --json shows', () => {
    expect(describeFix(checkLefthook('lefthook.yml', true, undefined, false).fix!)).toEqual({
      description: 'lefthook install',
      cmd: ['lefthook', 'install'],
      cwd: '.',
    })
    expect(describeFix(ciPinFix(dir, '1.2.3'))).toEqual({ description: 'move the workflow pins to v1.2.3' })
  })
})

describe('applyFix', () => {
  test.each([
    ['lefthook', () => checkLefthook('lefthook.yml', true, undefined, false)],
    ['mise', () => checkMise({ java: '21' }, { java: '17' })],
  ] as const)('%s install runs in the repo root', async (bin, check) => {
    fake(bin)
    const c = check()
    expect(await applyFix(dir, c.id, c.fix!)).toEqual({
      id: c.id,
      description: `${bin} install`,
      applied: true,
      ok: true,
    })
    expect(calls()).toEqual([`${here()} ${bin} install`])
  })

  test('the install runs in the given dir with the given package manager', async () => {
    fake('bun')
    mkdirSync(join(dir, 'apps/api'), { recursive: true })
    const c = checkWranglerLogin(undefined, { cmd: ['bun', 'install'], cwd: 'apps/api' })
    expect((await applyFix(dir, c.id, c.fix!)).ok).toBe(true)
    expect(calls()).toEqual(['api bun install'])
  })

  test('a failing command: applied, not ok, with its last line', async () => {
    fake('lefthook', 'echo "noise"; echo "no git repo" >&2; exit 3')
    const c = checkLefthook('lefthook.yml', true, undefined, false)
    expect(await applyFix(dir, c.id, c.fix!)).toEqual({
      id: 'lefthook',
      description: 'lefthook install',
      applied: true,
      ok: false,
      error: 'exit 3: no git repo',
    })
  })

  test('a command that is not on PATH is not applied', async () => {
    const fix: Fix = { description: 'x', action: { cmd: ['kit-no-such-binary', 'install'] } }
    expect(await applyFix(dir, 'x', fix)).toEqual({
      id: 'x',
      description: 'x',
      applied: false,
      ok: false,
      error: 'kit-no-such-binary not found',
    })
  })

  test('chmod +x makes the wrapper executable', async () => {
    writeFileSync(join(dir, 'kotlin'), '#!/bin/sh\n', { mode: 0o644 })
    const c = checkToolchain('.', '#!/bin/sh\n', false)
    expect((await applyFix(dir, c.id, c.fix!)).ok).toBe(true)
    expect(statSync(join(dir, 'kotlin')).mode & 0o111).not.toBe(0)
  })

  test('iOS: MARKETING_VERSION takes the TOML value, the rest of the file stays', async () => {
    writeFileSync(join(dir, 'Config.xcconfig'), 'TEAM = ABC\nMARKETING_VERSION = 1.1.0 // shown\n')
    const fix = iosVersionFix(dir, { toml: '1.2.0', file: 'Config.xcconfig' })
    expect((await applyFix(dir, 'ios-version', fix)).ok).toBe(true)
    expect(readFileSync(join(dir, 'Config.xcconfig'), 'utf8')).toBe(
      'TEAM = ABC\nMARKETING_VERSION = 1.2.0 // shown\n',
    )
  })

  test('iOS: an unreadable xcconfig is a failed fix, not a crash', async () => {
    const r = await applyFix(dir, 'ios-version', iosVersionFix(dir, { toml: '1.2.0', file: 'No.xcconfig' }))
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toContain('No.xcconfig')
  })

  test('Android: module.yaml versionName takes the TOML value', async () => {
    mkdirSync(join(dir, 'app'))
    const yaml =
      'product: android/app\n\nsettings:\n  android:\n    versionName: "1.1.0"\n    namespace: a.b\n'
    writeFileSync(join(dir, 'app/module.yaml'), yaml)
    const fix = androidVersionFix(dir, { toml: '1.2.0', file: 'app/module.yaml' })
    expect((await applyFix(dir, 'android-version', fix)).ok).toBe(true)
    expect(readFileSync(join(dir, 'app/module.yaml'), 'utf8')).toBe(yaml.replace('1.1.0', '1.2.0'))
  })

  describe('CI pin', () => {
    const SHA = 'b'.repeat(40)
    const wf = '.github/workflows'
    const ci = `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@abc # v7\n      - uses: jordond/kit/.github/actions/setup@${'a'.repeat(40)} # v1.0.0\n`
    beforeEach(() => {
      mkdirSync(join(dir, wf), { recursive: true })
      writeFileSync(join(dir, wf, 'ci.yml'), ci)
      writeFileSync(join(dir, wf, 'other.yml'), 'jobs: {}\n')
    })

    test('the pins move to the tag commit of the npm pin; other actions stay', async () => {
      const asked: string[] = []
      const fix = ciPinFix(dir, '1.2.3', async (v) => {
        asked.push(v)
        return SHA
      })
      expect(await applyFix(dir, 'ci-pin', fix)).toMatchObject({ applied: true, ok: true })
      expect(asked).toEqual(['1.2.3'])
      const text = readFileSync(join(dir, wf, 'ci.yml'), 'utf8')
      expect(text).toContain(`jordond/kit/.github/actions/setup@${SHA} # v1.2.3`)
      expect(text).toContain('actions/checkout@abc # v7')
      expect(checkCiPin([{ file: 'ci.yml', text }], '^1.2.3', true).status).toBe('ok')
      expect(readFileSync(join(dir, wf, 'other.yml'), 'utf8')).toBe('jobs: {}\n')
    })

    test('offline: skipped with a note, nothing written', async () => {
      const r = await applyFix(
        dir,
        'ci-pin',
        ciPinFix(dir, '1.2.3', async () => undefined),
      )
      expect(r).toEqual({
        id: 'ci-pin',
        description: 'move the workflow pins to v1.2.3',
        applied: false,
        ok: false,
        error: 'v1.2.3 not found in the kit repo (offline?): workflow pins left as they are',
      })
      expect(readFileSync(join(dir, wf, 'ci.yml'), 'utf8')).toBe(ci)
    })
  })
})
