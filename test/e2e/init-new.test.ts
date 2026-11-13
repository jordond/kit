import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { type Fixture, fixture } from '../helpers/fixture'

/** `kit init` in a repo without kit.config.ts, and `kit upgrade` on the result. */

const KIT = resolve(import.meta.dir, '../..')
const NEXT = '9.9.9'

function sh(cmd: string[], cwd: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

// Stands in for kit's GitHub repo: annotated tags for the running version and a later one.
let remote = ''
let empty = ''
const shas: Record<string, string> = {}
beforeAll(() => {
  remote = mkdtempSync(join(tmpdir(), 'kit-remote-'))
  empty = mkdtempSync(join(tmpdir(), 'kit-remote-empty-'))
  sh(['git', 'init', '-q', '--bare', empty], empty)
  sh(['git', 'init', '-q', '-b', 'main'], remote)
  for (const v of [pkg.version, NEXT]) {
    const git = ['git', '-c', 'user.email=t@example.com', '-c', 'user.name=T']
    sh([...git, 'commit', '-q', '--allow-empty', '-m', `chore(release): ${v}`], remote)
    sh([...git, 'tag', '-a', `v${v}`, '-m', `v${v}`], remote)
    shas[v] = sh(['git', 'rev-parse', 'HEAD'], remote)
  }
})
afterAll(() => {
  rmSync(remote, { recursive: true, force: true })
  rmSync(empty, { recursive: true, force: true })
})

let f: Fixture
let home = ''
const read = (p: string) => readFileSync(join(f.dir, p), 'utf8')
const has = (p: string) => existsSync(join(f.dir, p))
const lines = (name: string) => (has(name) ? read(name).split('\n').filter(Boolean) : [])

const run = (args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
  f.kit(args, {
    cwd: opts.cwd,
    env: {
      KIT_REPO_URL: remote,
      KIT_TEST_LOG: join(f.dir, '.kotlin.log'),
      KIT_BUN_LOG: join(f.dir, '.bun.log'),
      HOME: home,
      // Runners set these; completion must land in the test's home.
      XDG_CONFIG_HOME: '',
      ZDOTDIR: '',
      SHELL: '/bin/zsh',
      ...opts.env,
    },
  })

beforeEach(() => {
  f = fixture('new-toolchain', [])
  home = mkdtempSync(join(tmpdir(), 'kit-home-'))
  // kit itself runs on the real bun (the helper spawns process.execPath); these catch what it spawns.
  // The helper's recording fakes call `bun`, so they cannot sit next to a fake bun.
  for (const bin of ['bun', 'bundle'])
    f.script(bin, `echo "$(basename "$PWD") ${bin === 'bun' ? '' : 'bundle '}$*" >> "$KIT_BUN_LOG"`)
  writeFileSync(join(f.dir, '.gitignore'), '/build/\n.fakebin/\n')
})
afterEach(() => {
  f.cleanup()
  rmSync(home, { recursive: true, force: true })
})

describe('kit init in a Kotlin toolchain project', () => {
  test('--dry-run --json: the toolchain template is offered, planned, and nothing is written', async () => {
    const r = await run(['init', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.stdout) as {
      template: string
      files: { kind: string; path: string }[]
      plan: { kind: string; title: string; cmd?: string[]; cwd?: string }[]
    }
    expect(doc.template).toBe('toolchain')
    expect(doc.files.map((a) => `${a.kind} ${a.path}`)).toEqual([
      'write .kit/package.json',
      'write .kit/kit.config.ts',
      'write .editorconfig',
      'write .env.example',
      'write .github/workflows/ci.yml',
      'write .github/workflows/distribute.yml',
      'write fastlane/Fastfile',
      'write renovate.json',
      'edit .gitignore',
      'edit libs.versions.toml',
    ])
    expect(doc.plan.map((a) => `${a.kind} ${a.title}`)).toEqual([
      'env-file .env from .env.example',
      'cmd bun install (.kit)',
      'scaffold mise.toml',
      'scaffold lefthook.yml',
      'cmd kotlin --version',
      'cmd bundle install (kit fastlane)',
    ])
    expect(doc.plan[1]).toMatchObject({ cmd: ['bun', 'install'], cwd: '.kit' })
    expect(has('.kit')).toBe(false)
    expect(has('.env.example')).toBe(false)
    expect(lines('.bun.log')).toEqual([])
  })

  test('without a terminal, --yes or --template it only says so', async () => {
    const r = await run(['init'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('re-run with `--template toolchain`')
    expect(has('.kit')).toBe(false)
    expect(has('mise.toml')).toBe(false)
  })

  test('--template toolchain writes the kit files, then sets the clone up', async () => {
    const r = await run(['init', '--template', 'toolchain', '--name', 'Demo'])
    expect(r.stderr).toContain('init complete')
    expect(r.code).toBe(0)

    // kit lives in .kit/, config included; the root gets no package.json.
    expect(has('package.json')).toBe(false)
    expect(JSON.parse(read('.kit/package.json'))).toEqual({
      name: 'demo',
      private: true,
      type: 'module',
      devDependencies: { '@jordond/kit': `^${pkg.version}`, zod: pkg.peerDependencies.zod },
    })
    const config = read('.kit/kit.config.ts')
    expect(config).toContain("name: 'Demo'")
    expect(config).toContain("dev: './kotlin run -m desktopApp'")
    expect(config).toContain("packageName: 'app.example.demo'")
    expect(config).toContain("xcconfig: 'iosApp/Configuration/Config.xcconfig'")
    expect(has('kit.config.ts')).toBe(false)

    const pin = `@${shas[pkg.version]} # v${pkg.version}`
    expect(read('.github/workflows/ci.yml')).toContain(`jordond/kit/.github/actions/setup${pin}`)
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: kit test -- --platform jvm --platform android --platform wasmJs',
    )
    expect(read('.github/workflows/distribute.yml')).toContain(
      `jordond/kit/.github/workflows/mobile-distribute.yml${pin}`,
    )
    expect(read('fastlane/Fastfile')).toContain('KIT_FASTFILE')
    expect(read('.editorconfig')).toContain('[*.{kt,kts}]')
    expect(read('.gitignore')).toBe('/build/\n.fakebin/\nnode_modules/\n.env\nbackups/\n')
    expect(read('libs.versions.toml')).toStartWith(
      '[versions]\napp-android-version = "0.3.0"\napp-ios-version = "0.2.0"\nlogback = "1.6.2"\n',
    )
    expect(read('mise.toml')).toContain('ktlint = ')
    expect(read('mise.toml')).not.toContain('java')
    expect(read('lefthook.yml')).toContain('run: ./.kit/node_modules/.bin/kit lint --staged --fix')
    expect(statSync(join(f.dir, '.env')).mode & 0o777).toBe(0o600)

    expect(lines('.bun.log')).toEqual(['.kit install', `${f.dir.split('/').pop()} bundle install`])
    expect(lines('.kotlin.log')).toEqual(['--version'])

    // The new config is the repo's config from anywhere inside it, `.kit` included.
    for (const cwd of ['shared', '.kit']) {
      const shown = JSON.parse((await run(['config'], { cwd })).stdout)
      expect(shown.root.replace(/^\/private/, '')).toBe(f.dir.replace(/^\/private/, ''))
      expect(shown.config.release.android.module).toBe('androidApp')
    }
    const checks = JSON.parse((await run(['doctor', '--json'])).stdout).checks as {
      id: string
      status: string
    }[]
    expect(checks.find((c) => c.id === 'ci-pin')).toMatchObject({ status: 'ok', detail: pkg.version })
    expect(checks.find((c) => c.id === 'android-version')).toMatchObject({ status: 'ok' })

    // Again: an ordinary clone setup, nothing rewritten.
    const again = await run(['init', '--json'])
    expect(again.code).toBe(0)
    const steps = JSON.parse(again.stdout).steps as { title: string; skipped?: string }[]
    expect(steps.filter((s) => s.skipped).map((s) => s.title)).toEqual(['.env', 'mise.toml', 'lefthook.yml'])
    expect((await run(['init', '--template', 'toolchain'])).code).toBe(2)
  }, 30_000)

  test('existing files are kept', async () => {
    writeFileSync(join(f.dir, '.editorconfig'), 'root = true\n')
    writeFileSync(join(f.dir, '.mise.toml'), '[tools]\n')
    const r = await run(['init', '--yes'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('- .editorconfig  exists')
    expect(r.stderr).toContain('- mise.toml  .mise.toml exists')
    expect(read('.editorconfig')).toBe('root = true\n')
    expect(has('mise.toml')).toBe(false)
  })

  test('an untagged kit version pins the tag and says so', async () => {
    const r = await run(['init', '--yes'], { env: { KIT_REPO_URL: empty } })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`v${pkg.version} not found on GitHub`)
    expect(read('.github/workflows/ci.yml')).toContain(
      `jordond/kit/.github/actions/setup@v${pkg.version} # v${pkg.version}`,
    )
  })

  test('the launcher finds .kit/kit.config.ts', async () => {
    expect((await run(['init', '--yes'])).code).toBe(0)
    const copy = mkdtempSync(join(tmpdir(), 'kit-launcher-'))
    try {
      mkdirSync(join(copy, 'bin'))
      writeFileSync(join(copy, 'bin/kit'), readFileSync(join(KIT, 'bin/kit')))
      // A stand-in for the package's cli: prints the root the launcher exported.
      mkdirSync(join(copy, 'src'))
      writeFileSync(join(copy, 'src/cli.ts'), 'console.log(process.env.KIT_ROOT ?? "none")\n')
      for (const cwd of ['.', 'androidApp', '.kit']) {
        const out = Bun.spawnSync(['sh', join(copy, 'bin/kit')], {
          cwd: join(f.dir, cwd),
          env: { ...process.env, KIT_DEV: '', KIT_ROOT: '' },
        })
        expect(
          out.stdout
            .toString()
            .trim()
            .replace(/^\/private/, ''),
        ).toBe(f.dir.replace(/^\/private/, ''))
      }
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})

describe('kit init --template elsewhere', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-new-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('gradle: kit in the root package.json and a Gradle client skeleton', async () => {
    const r = await run(['--cwd', dir, 'init', '--template', 'gradle', '--name', 'Demo', '--js-only'])
    expect(r.code).toBe(0)
    const at = (p: string) => readFileSync(join(dir, p), 'utf8')
    expect(JSON.parse(at('package.json')).devDependencies['@jordond/kit']).toBe(`^${pkg.version}`)
    expect(at('kit.config.ts')).toContain("name: 'Demo'")
    expect(at('apps/client/settings.gradle.kts')).toContain('rootProject.name = "Demo"')
    expect(at('.github/workflows/ci.yml')).toContain(`setup@${shas[pkg.version]} # v${pkg.version}`)
    expect(at('.gitignore')).toBe('node_modules/\n.env\nbackups/\n')
    expect(at('mise.toml')).toContain('java = ')
    expect(at('lefthook.yml')).toContain('run: kit lint --staged --fix')
    expect(JSON.parse(at('renovate.json')).extends).toContain('github>jordond/kit//renovate/default')
    expect(existsSync(join(dir, '.kit'))).toBe(false)
    expect(lines('.bun.log')).toEqual([`${dir.split('/').pop()} install`])
  })

  test('a plain directory gets a hint, not a scaffold', async () => {
    const r = await run(['--cwd', dir, 'init'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('kit init --template gradle')
    expect(existsSync(join(dir, 'kit.config.ts'))).toBe(false)
  })

  test('a name that cannot sit in a string literal is refused before anything is written', async () => {
    const r = await run(['--cwd', dir, 'init', '--template', 'gradle', '--name', "it's"])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('cannot be the app name')
    expect(readdirSync(dir)).toEqual([])
  })

  test('toolchain needs a toolchain project; unknown templates are usage errors', async () => {
    const r = await run(['--cwd', dir, 'init', '--template', 'toolchain'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('No Kotlin toolchain project here')
    expect((await run(['--cwd', dir, 'init', '--template', 'maven'])).code).toBe(2)
  })
})

describe('kit init shell completion', () => {
  // Not CI, and `kit` on PATH: the script calls back into it.
  const env = { CI: '' }
  beforeEach(() => f.script('kit', 'exit 0'))

  test('zsh: --yes writes a static script and sources it from .zshrc once', async () => {
    writeFileSync(join(home, '.zshrc'), 'export EDITOR=vi')
    const r = await run(['init', '--yes', '--js-only'], { env })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('zsh completion')
    const script = join(home, '.config/kit/completion.zsh')
    expect(readFileSync(script, 'utf8')).toStartWith('#compdef kit')
    const rc = readFileSync(join(home, '.zshrc'), 'utf8')
    expect(rc).toBe(
      `export EDITOR=vi\n\n# kit shell completion\n[ -f "${script}" ] && { (( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }; source "${script}"; }\n`,
    )
    // Starting a shell runs no kit.
    expect(rc).not.toContain('kit completion')
    const again = await run(['init', '--yes', '--js-only'], { env })
    expect(again.stderr).toContain('- zsh completion  already in ~/.zshrc')
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(rc)
  })

  test('zsh: the installed lines load in a shell that never ran compinit', async () => {
    if (!Bun.which('zsh')) return
    expect((await run(['init', '--yes', '--js-only'], { env })).code).toBe(0)
    const out = Bun.spawnSync(['zsh', '-f', '-c', 'source "$HOME/.zshrc" && print -r -- "$_comps[kit]"'], {
      env: { ...process.env, HOME: home, ZDOTDIR: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(out.stderr.toString()).not.toContain('command not found')
    expect(out.stdout.toString().trim()).not.toBe('')
  })

  test('fish: writes the completions file', async () => {
    const r = await run(['init', '--yes', '--js-only'], { env: { ...env, SHELL: '/usr/local/bin/fish' } })
    expect(r.code).toBe(0)
    expect(readFileSync(join(home, '.config/fish/completions/kit.fish'), 'utf8')).toContain(
      'fish completion for kit',
    )
  })

  test('no terminal and no --yes: skipped with the reason; CI: not planned', async () => {
    const r = await run(['init', '--template', 'toolchain', '--js-only'], { env })
    expect(r.stderr).toContain('- zsh completion  no terminal; re-run with --yes to install it')
    expect(existsSync(join(home, '.zshrc'))).toBe(false)
    const ci = await run(['init', '--yes', '--js-only'])
    expect(ci.stderr).not.toContain('completion')
  })
})

describe('kit upgrade', () => {
  beforeEach(async () => {
    expect((await run(['init', '--yes', '--js-only'])).code).toBe(0)
    writeFileSync(join(f.dir, '.bun.log'), '')
  })

  test('moves the pin in .kit/package.json, installs, and repins the workflows', async () => {
    const r = await run(['upgrade', NEXT, '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      from: `^${pkg.version}`,
      to: `^${NEXT}`,
      manifest: '.kit/package.json',
      sha: shas[NEXT],
      workflows: [
        { file: '.github/workflows/ci.yml', pins: 2 },
        { file: '.github/workflows/distribute.yml', pins: 1 },
      ],
    })
    expect(JSON.parse(read('.kit/package.json')).devDependencies['@jordond/kit']).toBe(`^${NEXT}`)
    expect(lines('.bun.log')).toEqual(['.kit install'])
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain(`jordond/kit/.github/actions/setup@${shas[NEXT]} # v${NEXT}`)
    expect(ci).not.toContain(shas[pkg.version]!)
    expect(ci).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7')
    const checks = JSON.parse((await run(['doctor', '--json'])).stdout).checks as {
      id: string
      status: string
    }[]
    expect(checks.find((c) => c.id === 'ci-pin')).toMatchObject({ status: 'ok', detail: NEXT })

    // Already there: nothing to install or rewrite.
    const again = await run(['upgrade', NEXT])
    expect(again.code).toBe(0)
    expect(again.stderr).toContain(`already on kit ${NEXT}`)
    expect(lines('.bun.log')).toEqual(['.kit install'])
  })

  test('no version: the latest on npm', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/@jordond/kit/latest'
          ? Response.json({ version: NEXT })
          : new Response('not found', { status: 404 }),
    })
    try {
      const r = await run(['upgrade'], { env: { KIT_REGISTRY: `http://localhost:${server.port}` } })
      expect(r.code).toBe(0)
      expect(r.stderr).toContain(`@jordond/kit ^${pkg.version} → ^${NEXT}`)
      expect(read('.kit/package.json')).toContain(`"@jordond/kit": "^${NEXT}"`)
    } finally {
      await server.stop(true)
    }
  })

  test('--dry-run changes nothing', async () => {
    const before = [read('.kit/package.json'), read('.github/workflows/ci.yml')]
    const r = await run(['upgrade', NEXT, '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('.github/workflows/ci.yml: 2 pins')
    expect([read('.kit/package.json'), read('.github/workflows/ci.yml')]).toEqual(before)
    expect(lines('.bun.log')).toEqual([])
  })

  test('a version without a tag bumps the pin, leaves the workflows, and fails', async () => {
    const before = read('.github/workflows/ci.yml')
    const r = await run(['upgrade', '8.0.0'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('v8.0.0 not found in the kit repo')
    expect(read('.github/workflows/ci.yml')).toBe(before)
    expect(read('.kit/package.json')).toContain('"@jordond/kit": "^8.0.0"')
  })

  test('a failed install restores the pin and leaves the workflows', async () => {
    const before = [read('.kit/package.json'), read('.github/workflows/ci.yml')]
    f.script('bun', 'exit 1')
    const r = await run(['upgrade', NEXT])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('.kit/package.json restored')
    expect([read('.kit/package.json'), read('.github/workflows/ci.yml')]).toEqual(before)
  })

  test('usage and config errors', async () => {
    expect((await run(['upgrade', 'latest'])).code).toBe(2)
    expect((await run(['upgrade', '1.0.0","x":"y'])).code).toBe(2)
    writeFileSync(
      join(f.dir, '.kit/package.json'),
      '{ "devDependencies": { "@jordond/kit": "file:../kit.tgz" } }',
    )
    const r = await run(['upgrade', NEXT])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('not a version range')
  })
})

describe('kit upgrade --global', () => {
  // A kit that `bun add -g` installed, first on PATH; the fake bun "installs" by rewriting its version.
  let global = ''
  const version = () =>
    (JSON.parse(readFileSync(join(global, 'package.json'), 'utf8')) as { version: string }).version
  beforeEach(() => {
    global = join(home, '.bun/install/global/node_modules/@jordond/kit')
    mkdirSync(join(global, 'bin'), { recursive: true })
    writeFileSync(join(global, 'package.json'), '{"name":"@jordond/kit","version":"0.1.0"}')
    writeFileSync(join(global, 'bin/kit'), '#!/bin/sh\n')
    chmodSync(join(global, 'bin/kit'), 0o755)
    symlinkSync(join(global, 'bin/kit'), join(f.dir, '.fakebin/kit'))
    f.script(
      'bun',
      `echo "$(basename "$PWD") $*" >> "$KIT_BUN_LOG"
[ "$1" = add ] || exit 0
v=\${3##*@}
printf '{"name":"@jordond/kit","version":"%s"}' "$v" > "${global}/package.json"`,
    )
    writeFileSync(join(f.dir, '.bun.log'), '')
  })
  const installed = (v: string) => [`${home.split('/').pop()} add -g @jordond/kit@${v}`]

  test('outside a repo: installs the version over the kit on PATH, from home', async () => {
    const r = await run(['upgrade', NEXT])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`kit on PATH: 0.1.0 → ${NEXT}`)
    expect(r.stderr).toContain(`kit ${NEXT}`)
    expect(lines('.bun.log')).toEqual(installed(NEXT))
    expect(version()).toBe(NEXT)
    const again = await run(['upgrade', NEXT])
    expect(again.stderr).toContain(`already on kit ${NEXT}`)
    expect(lines('.bun.log')).toEqual(installed(NEXT))
  })

  test('no version: the latest on npm; a global kit ahead of it stays', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ version: '0.5.0' }) })
    const env = { KIT_REGISTRY: `http://localhost:${server.port}` }
    try {
      const r = await run(['upgrade', '--global', '--json'], { env })
      expect(JSON.parse(r.stdout)).toEqual({
        ok: true,
        global: true,
        from: '0.1.0',
        to: '0.5.0',
        command: 'bun add -g @jordond/kit@0.5.0',
      })
      writeFileSync(join(global, 'package.json'), '{"name":"@jordond/kit","version":"0.6.0-rc.1"}')
      const ahead = await run(['upgrade', '--global'], { env })
      expect(ahead.stderr).toContain('already on kit 0.6.0-rc.1')
      expect(lines('.bun.log')).toEqual(installed('0.5.0'))
    } finally {
      await server.stop(true)
    }
  })

  test('in a repo: --global leaves the repo alone, and a repo upgrade points at it', async () => {
    expect((await run(['init', '--yes', '--js-only'])).code).toBe(0)
    writeFileSync(join(f.dir, '.bun.log'), '')
    const before = read('.kit/package.json')
    const dry = await run(['upgrade', NEXT, '--global', '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.stderr).toContain(`bun add -g @jordond/kit@${NEXT}`)
    expect(lines('.bun.log')).toEqual([])
    expect(read('.kit/package.json')).toBe(before)
    const repo = await run(['upgrade', NEXT, '--dry-run'])
    expect(repo.stderr).toContain('The kit on PATH is still 0.1.0')
    expect(repo.stderr).toContain('kit upgrade --global')
  })

  test('a failed install, and a kit no package manager installed', async () => {
    f.script('bun', 'exit 1')
    const r = await run(['upgrade', NEXT])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`bun add -g @jordond/kit@${NEXT} failed (exit 1)`)
    const checkout = join(home, 'dev/kit')
    mkdirSync(join(checkout, 'bin'), { recursive: true })
    writeFileSync(join(checkout, 'package.json'), '{"name":"@jordond/kit","version":"0.1.0"}')
    writeFileSync(join(checkout, 'bin/kit'), '#!/bin/sh\n')
    chmodSync(join(checkout, 'bin/kit'), 0o755)
    rmSync(join(f.dir, '.fakebin/kit'))
    symlinkSync(join(checkout, 'bin/kit'), join(f.dir, '.fakebin/kit'))
    const linked = await run(['upgrade', NEXT])
    expect(linked.code).toBe(4)
    expect(linked.stderr).toContain('was not installed by a package manager')
  })
})
