import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit qa`, `kit shots`, `kit maestro`, the flow lint and doctor: a fake maestro records argv and writes run dirs. */

const PIXEL = 'emulator-5554 device product:sdk model:Pixel_8 device:emu'
const SERIAL = 'emulator-5554'

let f: Fixture
afterEach(() => f?.cleanup())

const env = () => ({ KIT_TEST_LOG: join(f.dir, '.maestro.log') })
const log = (): string[] =>
  existsSync(join(f.dir, '.maestro.log'))
    ? readFileSync(join(f.dir, '.maestro.log'), 'utf8').split('\n').filter(Boolean)
    : []
/** Calls other than the adb device probes. */
const acts = () => log().filter((l) => !/^adb devices/.test(l))
const maestroCalls = () => log().filter((l) => l.startsWith('maestro '))

/**
 * Fake maestro: logs argv, then writes `<test-output-dir>/<run>/<flow>/takeScreenshot/<first tag>.png`
 * (unless KIT_NO_PNG) and exits 1 when the tags are KIT_FAIL_TAGS. `--version` prints 2.9.0.
 */
const FAKE_MAESTRO = `
if [ "$1" = --version ]; then echo 2.9.0; exit 0; fi
if [ "$1" = hierarchy ]; then echo "analytics=$MAESTRO_CLI_NO_ANALYTICS cwd=$(basename "$PWD")"; exit 7; fi
echo "maestro $*" >> "$KIT_TEST_LOG"
if [ "$1" = check-syntax ]; then exit 0; fi
out=""; tags=""
while [ $# -gt 0 ]; do
  case "$1" in
    --test-output-dir) out="$2"; shift ;;
    --include-tags) tags="$2"; shift ;;
  esac
  shift
done
[ -n "$out" ] || exit 0
n=$(ls "$out" 2>/dev/null | wc -l | tr -d ' ')
run="$out/2026-01-01_0000$(printf %02d $((n + 1)))"
if [ -z "$KIT_NO_PNG" ]; then
  mkdir -p "$run/flow/takeScreenshot"
  echo "png $tags" > "$run/flow/takeScreenshot/\${tags%%,*}.png"
else
  mkdir -p "$run/flow"
fi
[ "$tags" = "$KIT_FAIL_TAGS" ] && exit 1
exit 0
`

function setup(extraBins: string[] = []) {
  f = fixture('maestro-app', ['adb', 'maestro', ...extraBins])
  f.script(
    'adb',
    `echo "adb $*" >> "$KIT_TEST_LOG"
if [ "$1" = devices ]; then printf 'List of devices attached\\n${PIXEL}\\n'; fi
exit 0`,
  )
  f.script('maestro', FAKE_MAESTRO)
}

const png = (dir: string) => readdirSync(join(f.dir, dir)).sort()

describe('kit qa', () => {
  test('android: builds and installs first, then each stage is its own maestro call', async () => {
    setup()
    const r = await f.kit(['qa', 'android', '--no-fixture'], { env: env() })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('✔ smoke, onboarding passed on android')
    const calls = acts()
    expect(calls[0]).toBe('gradlew :android:assembleDebug')
    expect(calls[1]).toMatch(new RegExp(`^adb -s ${SERIAL} install -r .*app-debug\\.apk$`))
    expect(maestroCalls()).toEqual([
      `maestro --device ${SERIAL} test maestro --include-tags smoke --test-output-dir maestro/output/android-qa -e PLATFORM=android -e LOCALE=en`,
      `maestro --device ${SERIAL} test maestro --include-tags onboarding --test-output-dir maestro/output/android-qa -e PLATFORM=android -e LOCALE=en`,
    ])
    expect(calls.indexOf(maestroCalls()[0]!)).toBeGreaterThan(1)
    expect(png('maestro/output/android-qa')).toHaveLength(2)
  })

  test('--no-build with no build to install is a precondition failure and builds nothing', async () => {
    setup()
    const r = await f.kit(['qa', 'android', '--no-build', '--no-fixture'], { env: env() })
    expect(r.code).toBe(4)
    expect(log().some((l) => l.startsWith('gradlew'))).toBe(false)
  })

  test('--no-build installs an existing build and runs the flows', async () => {
    setup()
    await f.kit(['app', 'build', 'android'], { env: env() })
    const r = await f.kit(['qa', 'android', '--no-build', '--no-fixture'], { env: env() })
    expect(r.code).toBe(0)
    expect(log().filter((l) => l.startsWith('gradlew'))).toHaveLength(1)
    expect(maestroCalls()).toHaveLength(2)
  })

  test('--tags replaces the stages with one', async () => {
    setup()
    const r = await f.kit(['qa', 'android', '--no-fixture', '--tags', 'auth,smoke'], { env: env() })
    expect(r.code).toBe(0)
    expect(maestroCalls()).toHaveLength(1)
    expect(maestroCalls()[0]).toContain('--include-tags auth,smoke')
  })

  test('a failing stage exits 1 naming its tags, and later stages do not run', async () => {
    setup()
    const r = await f.kit(['qa', 'android', '--no-fixture'], { env: { ...env(), KIT_FAIL_TAGS: 'smoke' } })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('smoke failed on android')
    expect(maestroCalls()).toHaveLength(1)
  })

  test('--junit writes one report per stage', async () => {
    setup()
    await f.kit(['qa', 'android', '--no-fixture', '--junit', 'reports/qa.xml'], { env: env() })
    const calls = maestroCalls()
    expect(calls[0]).toContain('--format JUNIT --output reports/qa.xml')
    expect(calls[1]).toContain('--format JUNIT --output reports/qa-2.xml')
  })

  test('--json is the result object alone on stdout', async () => {
    setup()
    const r = await f.kit(['qa', 'android', '--no-fixture', '--json'], { env: env() })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ suite: 'qa', target: 'android', device: SERIAL, ok: true })
    expect(doc.stages.map((s: { tags: string[] }) => s.tags)).toEqual([['smoke'], ['onboarding']])
    expect(doc.stages[0]).toMatchObject({ ok: true, code: 0, outputDir: 'maestro/output/android-qa' })
  })

  test('--dry-run --json plans everything and runs nothing', async () => {
    setup()
    const r = await f.kit(['qa', 'android', '--no-fixture', '--dry-run', '--json'], { env: env() })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc.suite).toBe('qa')
    expect(doc.target).toBe('android')
    const lines = doc.plan.map((c: string[]) => c.join(' '))
    expect(lines[0]).toBe('./gradlew :android:assembleDebug')
    expect(lines.at(-1)).toContain('--include-tags onboarding')
    expect(lines.some((l: string) => l.includes(`--device ${SERIAL}`))).toBe(true)
    expect(acts()).toEqual([])
  })

  test('a dry run with no device running shows a <device> placeholder', async () => {
    setup()
    f.script(
      'adb',
      `echo "adb $*" >> "$KIT_TEST_LOG"\nif [ "$1" = devices ]; then echo 'List of devices attached'; fi`,
    )
    const r = await f.kit(['qa', 'android', '--no-fixture', '--dry-run', '--json'], { env: env() })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).plan.at(-1)).toContain('<device>')
  })

  test('an unknown platform is a usage error', async () => {
    setup()
    expect((await f.kit(['qa', 'windows'], { env: env() })).code).toBe(2)
  })
})

describe('kit shots', () => {
  test('pins the status bar, then copies the PNGs to <screenshots>/<target>/', async () => {
    setup()
    const r = await f.kit(['shots', 'android', '--no-fixture'], { env: env() })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('✔ 1 screenshot under maestro/screenshots/android')
    expect(png('maestro/screenshots/android')).toEqual(['screenshots.png'])
    const calls = acts()
    const bar = calls.findIndex((l) => l.includes('sysui_demo_allowed'))
    expect(bar).toBeGreaterThan(calls.findIndex((l) => l.includes(' install ')))
    expect(bar).toBeLessThan(calls.findIndex((l) => l.startsWith('maestro ')))
  })

  test('--out is used as is', async () => {
    setup()
    const r = await f.kit(['shots', 'android', '--no-fixture', '--out', 'brand/shots'], { env: env() })
    expect(r.code).toBe(0)
    expect(png('brand/shots')).toEqual(['screenshots.png'])
  })

  test('--full runs the two shots-full stages in order and keeps both sets of PNGs', async () => {
    setup()
    const r = await f.kit(['shots', 'android', '--full', '--no-fixture'], { env: env() })
    expect(r.code).toBe(0)
    const calls = maestroCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('--include-tags screenshots ')
    expect(calls[1]).toContain('--include-tags screenshots-extra ')
    expect(calls[0]).toContain('android-shots-full')
    expect(png('maestro/screenshots/android')).toEqual(['screenshots-extra.png', 'screenshots.png'])
  })

  test('--full without a shots-full suite is a config error with an example', async () => {
    setup()
    const configPath = join(f.dir, 'kit.config.ts')
    await Bun.write(configPath, (await Bun.file(configPath).text()).replace(/'shots-full': \{[^}]*\},?/, ''))
    const r = await f.kit(['shots', 'android', '--full', '--no-fixture'], { env: env() })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('shots-full')
    expect(r.stderr).toContain('stages')
  })

  test('flows that pass but take no screenshot fail the run', async () => {
    setup()
    const r = await f.kit(['shots', 'android', '--no-fixture'], { env: { ...env(), KIT_NO_PNG: '1' } })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('took no screenshot')
  })

  test('a shot replaces the file of the same name and leaves the rest', async () => {
    setup()
    await Bun.write(join(f.dir, 'maestro/screenshots/android/other.png'), 'keep')
    await Bun.write(join(f.dir, 'maestro/screenshots/android/screenshots.png'), 'old')
    await f.kit(['shots', 'android', '--no-fixture'], { env: env() })
    expect(readFileSync(join(f.dir, 'maestro/screenshots/android/other.png'), 'utf8')).toBe('keep')
    expect(readFileSync(join(f.dir, 'maestro/screenshots/android/screenshots.png'), 'utf8')).toContain('png')
  })
})

describe('kit shots beside kit shots export', () => {
  const SIMS = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
        {
          udid: 'UDID-PHONE',
          name: 'iPhone 17',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: 'x',
        },
      ],
    },
  })

  test('`kit shots ios --dry-run` still takes the target as a positional', async () => {
    setup(['xcrun'])
    f.script('xcrun', `case "$*" in "simctl list devices -j") echo '${SIMS}' ;; esac`)
    const r = await f.kit(['shots', 'ios', '--no-fixture', '--dry-run', '--json'], {
      env: env(),
    })
    expect(r.stderr).toContain('using iPhone 17')
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout)
    expect(doc).toMatchObject({ suite: 'shots', target: 'ios' })
    expect(doc.plan.some((c: string[]) => c.join(' ').includes('--include-tags screenshots'))).toBe(true)
    expect(maestroCalls()).toEqual([])
  })

  test('`kit shots android --dry-run` plans the suite, and a bad target is still the shots usage error', async () => {
    setup()
    const ok = await f.kit(['shots', 'android', '--no-fixture', '--dry-run', '--json'], { env: env() })
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.stdout)).toMatchObject({ suite: 'shots', target: 'android' })
    const bad = await f.kit(['shots', 'exprot'], { env: env() })
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('kit shots <ios|ipad|android>')
  })

  test('`kit shots export --help` shows the export flags; `kit shots --help` lists export', async () => {
    setup()
    const help = await f.kit(['shots', 'export', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('kit shots export [options]')
    for (const flag of ['--store', '--locale', '--out', '--allow-missing', '--force']) {
      expect(help.stdout).toContain(flag)
    }
    const group = await f.kit(['shots', '--help'])
    expect(group.code).toBe(0)
    expect(group.stdout).toContain('kit shots <command> [options]')
    expect(group.stdout).toMatch(/export\s+Render the store screenshots/)
    expect(group.stdout).toContain('--full')
  })

  test('`kit shots export` resolves to the export command: a bad --store is its usage error', async () => {
    setup()
    const r = await f.kit(['shots', 'export', '--store', 'amazon'], { env: env() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--store takes apple, google or both')
    expect(log()).toEqual([])
  })
})

describe('kit maestro', () => {
  test('passes arguments through with the env, in the repo root, and returns the exit code', async () => {
    setup()
    const r = await f.kit(['maestro', 'hierarchy'], { cwd: 'maestro' })
    expect(r.code).toBe(7)
    expect(r.stdout).toContain('analytics=1')
    expect(r.stdout).toContain(`cwd=${f.dir.split('/').pop()}`)
  })

  test('without the binary: exit 4 with the install hint', async () => {
    f = fixture('maestro-app', [])
    const r = await f.kit(['maestro', '--version'], { env: { HOME: f.dir, PATH: '/usr/bin:/bin' } })
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('MAESTRO_VERSION=2.9.0 curl -Ls https://get.maestro.mobile.dev | bash')
  })
})

describe('kit lint (flows)', () => {
  test('checks every flow file except config.yaml, one maestro call each', async () => {
    setup()
    const r = await f.kit(['lint'], { env: env() })
    expect(r.code).toBe(0)
    expect(
      log()
        .filter((l) => l.includes('check-syntax'))
        .sort(),
    ).toEqual([
      'maestro check-syntax maestro/flows/shots.yml',
      'maestro check-syntax maestro/flows/smoke.yaml',
    ])
  })

  test('`kit lint maestro` runs only the flow check', async () => {
    setup()
    const r = await f.kit(['lint', 'maestro', '--dry-run', '--json'], { env: env() })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).plan.map((g: { target: string }) => g.target)).toEqual(['maestro'])
  })

  test('maestro absent: one warning, lint still passes', async () => {
    f = fixture('maestro-app', [])
    const r = await f.kit(['lint'], { env: { HOME: f.dir, PATH: '/usr/bin:/bin' } })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('maestro is not installed')
    expect(r.stderr.match(/maestro is not installed/g)).toHaveLength(1)
  })
})

describe('kit doctor', () => {
  test('reports the maestro checks when the repo configures maestro', async () => {
    setup()
    const r = await f.kit(['doctor', '--json'], { env: { HOME: f.dir } })
    const doc = JSON.parse(r.stdout)
    const maestro = doc.checks.find((c: { id: string }) => c.id === 'maestro')
    expect(maestro).toMatchObject({ status: 'ok', detail: '2.9.0' })
    expect(doc.checks.some((c: { id: string }) => c.id === 'maestro-java')).toBe(true)
  })
})
