import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hookKit,
  type InitState,
  kitPackageRoot,
  planInit,
  renderTemplate,
  scaffoldTemplate,
} from '../../src/commands/init'
import { configSchema } from '../../src/config/schema'
import { completionInstalled, completionTargets, rcSnippet, shellOf } from '../../src/lib/completion'

const config = configSchema.parse({
  name: 'X',
  env: { outputs: { 'apps/api/.dev.vars': {} } },
  targets: {
    api: { kind: 'worker', dir: 'apps/api' },
    edge: { kind: 'worker', dir: 'apps/edge' },
    web: { kind: 'astro', dir: 'apps/web' },
  },
})

const state = (files: string[], over: Partial<InitState> = {}): InitState => ({
  root: '/r',
  config,
  exists: (p) => files.includes(p),
  pm: 'bun',
  accepted: [],
  self: ['kit'],
  exec: (_cwd, bin, ...args) => ['bun', 'x', bin, ...args],
  ...over,
})

const titles = (s: InitState) => planInit(s).map((a) => `${a.kind} ${a.title}`)

describe('planInit', () => {
  test('fresh clone: env file, install, env sync, wrangler types where a wrangler config exists', () => {
    expect(titles(state(['.env.example', 'package.json', 'apps/api/wrangler.jsonc']))).toEqual([
      'env-file .env from .env.example',
      'cmd bun install',
      'skip mise.toml',
      'skip lefthook.yml',
      'cmd kit env sync',
      'cmd wrangler types (api)',
    ])
  })

  test('env sync runs as a child kit with KIT_ROOT', () => {
    const sync = planInit(state([])).find((a) => a.title === 'kit env sync')
    expect(sync).toMatchObject({ cmd: ['kit', 'env', 'sync'], cwd: '/r', env: { KIT_ROOT: '/r' } })
  })

  test('idempotent: existing files are skipped with the reason', () => {
    const plan = planInit(
      state(['.env.example', '.env', '.mise.toml', 'lefthook.yml'], { accepted: ['mise', 'lefthook'] }),
    )
    expect(plan.filter((a) => a.kind === 'skip').map((a) => (a as { reason: string }).reason)).toEqual([
      'already exists',
      'no package.json',
      '.mise.toml exists',
      'lefthook.yml exists',
    ])
  })

  test('accepted scaffolds are written; declined ones carry the reason', () => {
    const plan = titles(state([], { accepted: ['lefthook'], declinedReason: 'no terminal' }))
    expect(plan).toContain('scaffold lefthook.yml')
    expect(plan).toContain('skip mise.toml')
  })

  test('the agent guide is its own step: written, written with the hook, or skipped with the reason', () => {
    expect(titles(state([], { agents: { hooks: false } }))).toContain('agents AGENTS.md')
    expect(titles(state([], { agents: { hooks: true } }))).toContain(
      'agents AGENTS.md and the Claude Code hook',
    )
    const skipped = planInit(state([], { agents: { hooks: false, skip: 'up to date' } }))
    expect(skipped).toContainEqual({ kind: 'skip', title: 'AGENTS.md', reason: 'up to date' })
    expect(titles(state([])).some((t) => t.includes('AGENTS.md'))).toBe(false)
  })

  test('outside a project: no env sync, no wrangler types', () => {
    expect(titles(state(['package.json'], { config: undefined }))).toEqual([
      'skip .env',
      'cmd bun install',
      'skip mise.toml',
      'skip lefthook.yml',
    ])
  })
})

describe('planInit native steps', () => {
  const native = configSchema.parse({
    name: 'N',
    gradle: { root: 'apps/client', init: ':shared:dependencies' },
    targets: { client: { kind: 'gradle', dir: 'apps/client' } },
    release: {
      android: { packageName: 'a.b', module: ':android' },
      ios: { bundleIds: ['a.b'], project: 'p', scheme: 's', output: 'o.ipa' },
    },
  })
  const files = ['apps/client/gradlew', 'apps/client/Gemfile', 'Gemfile']
  const all = (bin: string) => ['java', 'bundle', 'xcodebuild'].includes(bin)
  const nativeOf = (over: Partial<InitState>) =>
    planInit(
      state(files, { config: native, which: all, androidSdk: true, platform: 'darwin', ...over }),
    ).slice(4)

  test('gradle.init tasks through the wrapper, then bundle install where the Gemfile is (Gradle root first)', () => {
    expect(nativeOf({})).toEqual([
      {
        kind: 'cmd',
        title: 'gradle :shared:dependencies',
        cmd: ['./gradlew', '--console=plain', '-q', ':shared:dependencies'],
        cwd: '/r/apps/client',
      },
      {
        kind: 'cmd',
        title: 'bundle install (kit fastlane)',
        cmd: ['bundle', 'install'],
        cwd: '/r',
        env: {},
      },
    ])
  })

  test('missing tools skip with a hint; --js-only skips both', () => {
    const reasons = (over: Partial<InitState>) =>
      nativeOf(over).map((a) => `${a.title}: ${a.kind === 'skip' ? a.reason : 'run'}`)
    expect(reasons({ which: () => false })).toEqual([
      'gradle :shared:dependencies: no java on PATH; install a JDK',
      'bundle install (kit fastlane): no bundler on PATH; gem install bundler',
      'Xcode: no xcodebuild on PATH; install Xcode for iOS builds',
    ])
    expect(reasons({ androidSdk: false })[0]).toContain('no Android SDK; set ANDROID_HOME')
    expect(reasons({ jsOnly: true })).toEqual([
      'gradle :shared:dependencies: --js-only',
      'bundle install (kit fastlane): --js-only',
    ])
  })

  test('no gradle.init and no Gemfile: no native steps', () => {
    expect(planInit(state([], { which: all, androidSdk: true })).map((a) => a.title)).not.toContain(
      'bundle install',
    )
    expect(nativeOf({ config: { ...native, gradle: { root: 'apps/client' } } })[0]?.title).toBe(
      'bundle install (kit fastlane)',
    )
    const noRelease = { ...native, gradle: { root: 'apps/client' }, release: undefined }
    expect(nativeOf({ config: noRelease })[0]?.title).toBe('bundle install (apps/client)')
  })
})

describe('templates', () => {
  test('kitPackageRoot finds the templates', () => {
    const root = kitPackageRoot()
    expect(existsSync(join(root, 'templates/mise.toml'))).toBe(true)
    expect(existsSync(join(root, 'templates/lefthook.yml'))).toBe(true)
  })

  test('a toolchain repo gets the mise.toml without java; hooks call the repo kit when it is in .kit/', () => {
    const read = (t: string) => readFileSync(join(kitPackageRoot(), 'templates', t), 'utf8')
    expect(scaffoldTemplate('mise', false)).toBe('mise.toml')
    expect(read(scaffoldTemplate('mise', false))).toContain('java = ')
    expect(read(scaffoldTemplate('mise', true))).not.toContain('java')
    expect(read(scaffoldTemplate('mise', true))).toContain('ktlint = ')
    expect(scaffoldTemplate('lefthook', true)).toBe('lefthook.yml')
    expect(hookKit('.')).toBe('kit')
    expect(hookKit('.kit')).toBe('./.kit/node_modules/.bin/kit')
    expect(renderTemplate(read('lefthook.yml'), { kit: hookKit('.kit') })).toContain(
      'run: ./.kit/node_modules/.bin/kit lint --staged --fix',
    )
  })

  test('renderTemplate fills known placeholders and leaves the rest', () => {
    expect(renderTemplate('bun = "{{bun}}" {{other}}', { bun: '1.3.14' })).toBe('bun = "1.3.14" {{other}}')
  })
})

describe('shell completion', () => {
  test('shellOf knows zsh, bash and fish', () => {
    expect(shellOf('/opt/homebrew/bin/fish')).toBe('fish')
    expect(shellOf('/bin/zsh')).toBe('zsh')
    expect(shellOf('/bin/bash')).toBe('bash')
    expect(shellOf('/bin/tcsh')).toBeUndefined()
    expect(shellOf(undefined)).toBeUndefined()
  })

  test('completionTargets: a fish autoload file, or a script sourced from the rc file', () => {
    expect(completionTargets('fish', {}, '/h')).toEqual({ script: '/h/.config/fish/completions/kit.fish' })
    expect(completionTargets('fish', { XDG_CONFIG_HOME: '/x' }, '/h').script).toBe(
      '/x/fish/completions/kit.fish',
    )
    expect(completionTargets('zsh', {}, '/h')).toEqual({
      script: '/h/.config/kit/completion.zsh',
      rc: '/h/.zshrc',
    })
    expect(completionTargets('zsh', { ZDOTDIR: '/z' }, '/h').rc).toBe('/z/.zshrc')
    expect(completionTargets('bash', {}, '/h', 'linux').rc).toBe('/h/.bashrc')
    // Terminal on macOS starts login shells, which read .bash_profile.
    expect(completionTargets('bash', {}, '/h', 'darwin').rc).toBe('/h/.bash_profile')
  })

  test('rcSnippet sources the static script; zsh loads compinit first when it has not run', () => {
    expect(rcSnippet('bash', '/h/.config/kit/completion.bash')).toBe(
      '# kit shell completion\n[ -f "/h/.config/kit/completion.bash" ] && { source "/h/.config/kit/completion.bash"; }\n',
    )
    const zsh = rcSnippet('zsh', '/h/.config/kit/completion.zsh')
    expect(zsh).toContain('(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }; source ')
    // No kit process at shell start: a new terminal must not run a repo's kit.config.ts.
    expect(zsh).not.toContain('kit completion')
  })

  test('completionInstalled: the fish file exists, or the rc file loads it', () => {
    expect(completionInstalled(undefined, false)).toBe(false)
    expect(completionInstalled('', false)).toBe(true)
    expect(completionInstalled('autoload compinit\n', true)).toBe(false)
    expect(completionInstalled(rcSnippet('zsh', '/h/.config/kit/completion.zsh'), true)).toBe(true)
    expect(completionInstalled('source <(kit completion zsh)\n', true)).toBe(true)
    expect(completionInstalled(undefined, true)).toBe(false)
  })

  test('planInit: installs last, skips with the reason, plans nothing without a state', () => {
    const last = (over: Partial<InitState>) => planInit(state([], { config: undefined, ...over })).at(-1)
    expect(last({ completion: { shell: 'fish', file: '/h/kit.fish' } })).toEqual({
      kind: 'completion',
      title: 'fish completion',
      shell: 'fish',
      file: '/h/kit.fish',
    })
    expect(
      last({ completion: { shell: 'zsh', file: '/h/c.zsh', rc: '/h/.zshrc', skip: 'declined' } }),
    ).toEqual({
      kind: 'skip',
      title: 'zsh completion',
      reason: 'declined',
    })
    expect(last({})?.title).toBe('lefthook.yml')
  })
})
