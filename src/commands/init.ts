import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { defineCommand } from '../cli/command'
import { KIT_DIR } from '../config/load'
import type { KitConfig } from '../config/schema'
import type { CompletionState, Shell } from '../lib/completion'
import type { PackageManager } from '../lib/pm'

/**
 * `kit init`, existing-repo mode (brewd `cli init` + WhaleSay `ws init`, generalized): `.env` from
 * `.env.example`, install, optional mise/lefthook scaffolds, `kit env sync`, `wrangler types`, then
 * the native side: `gradle.init` tasks (needs java, and an Android SDK when release.android is set)
 * or the Kotlin toolchain's `toolchain.init` (default: `./kotlin --version`, which downloads it),
 * and `bundle install` where a Gemfile is (the Gradle root, else the repo root). A missing tool
 * skips its step with a hint instead of failing, so a JS-only machine still ends up set up.
 * Idempotent: whatever is already there is skipped. Every step runs even after a failure, so one
 * pass surfaces every problem; the exit code is 1 if any failed.
 *
 * New-repo mode (no kit.config.ts yet): `--template toolchain|gradle` writes the kit files first
 * (src/lib/scaffold.ts), then the steps above run against the new config. A Kotlin toolchain
 * project (a `kotlin` wrapper and project.yaml) is offered the toolchain template.
 */

export type Scaffold = 'mise' | 'lefthook'

export const SCAFFOLDS: Record<Scaffold, { file: string; alt: string[]; template: string }> = {
  mise: { file: 'mise.toml', alt: ['.mise.toml'], template: 'mise.toml' },
  lefthook: { file: 'lefthook.yml', alt: ['lefthook.yaml', '.lefthook.yml'], template: 'lefthook.yml' },
}

/**
 * The template file of a scaffold, under kit's `templates/`. A Kotlin toolchain repo gets its own
 * mise.toml: bun and ktlint, no java (the toolchain provisions its JDK).
 */
export function scaffoldTemplate(scaffold: Scaffold, toolchain: boolean): string {
  const { template } = SCAFFOLDS[scaffold]
  return scaffold === 'mise' && toolchain ? join('toolchain', template) : template
}

/** How a git hook reaches kit: the repo's own copy when kit lives in `.kit/`, else the one on PATH. */
export function hookKit(kitDir: string): string {
  return kitDir === '.' ? 'kit' : `./${kitDir}/node_modules/.bin/kit`
}

export interface InitState {
  root: string
  config: KitConfig | undefined
  exists: (repoPath: string) => boolean
  pm: PackageManager
  /** Scaffolds the user accepted (or `--yes` did). */
  accepted: Scaffold[]
  /** Why a missing scaffold isn't written, when nobody could be asked. */
  declinedReason?: string
  /** argv prefix that runs this kit (`bun --no-env-file …/cli.ts`). */
  self: string[]
  /** A node_modules binary run with the package manager of `cwd` (`bun x wrangler …`). */
  exec: (cwd: string, bin: string, ...args: string[]) => string[]
  /** Whether a tool is on PATH. Default: nothing is. */
  which?: (bin: string) => boolean
  /** Bundler env for kit's fastlane Gemfile. */
  bundleEnv?: () => Record<string, string>
  /** ANDROID_HOME / ANDROID_SDK_ROOT set, or sdk.dir in `<gradle root>/local.properties`. */
  androidSdk?: boolean
  platform?: NodeJS.Platform
  /** `--js-only`: skip the Gradle, Kotlin toolchain and bundler steps. */
  jsOnly?: boolean
  /** Shell completion for the user's shell; undefined (CI, unknown shell) plans nothing. */
  completion?: CompletionState
}

export type InitAction =
  | { kind: 'env-file'; title: string }
  | { kind: 'scaffold'; title: string; scaffold: Scaffold }
  | { kind: 'cmd'; title: string; cmd: string[]; cwd: string; env?: Record<string, string> }
  | { kind: 'completion'; title: string; shell: Shell; file: string; rc?: string }
  | { kind: 'skip'; title: string; reason: string }

const WRANGLER_CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']

/** What init would do, in order. Pure: everything it reads comes in through `state`. */
export function planInit(s: InitState): InitAction[] {
  const plan: InitAction[] = []
  if (!s.exists('.env.example')) plan.push({ kind: 'skip', title: '.env', reason: 'no .env.example' })
  else if (s.exists('.env')) plan.push({ kind: 'skip', title: '.env', reason: 'already exists' })
  else plan.push({ kind: 'env-file', title: '.env from .env.example' })

  if (s.exists('package.json')) {
    plan.push({ kind: 'cmd', title: `${s.pm} install`, cmd: [s.pm, 'install'], cwd: s.root })
  } else if (!s.exists(join(KIT_DIR, 'package.json'))) {
    plan.push({ kind: 'skip', title: 'install', reason: 'no package.json' })
  }
  // kit's own install dir (a Kotlin toolchain repo keeps package.json out of the root).
  if (s.exists(join(KIT_DIR, 'package.json'))) {
    plan.push({
      kind: 'cmd',
      title: `bun install (${KIT_DIR})`,
      cmd: ['bun', 'install'],
      cwd: join(s.root, KIT_DIR),
    })
  }

  for (const name of Object.keys(SCAFFOLDS) as Scaffold[]) {
    const { file, alt } = SCAFFOLDS[name]
    const title = file
    const present = [file, ...alt].find((f) => s.exists(f))
    if (present) plan.push({ kind: 'skip', title, reason: `${present} exists` })
    else if (s.accepted.includes(name)) plan.push({ kind: 'scaffold', title, scaffold: name })
    else plan.push({ kind: 'skip', title, reason: s.declinedReason ?? 'declined' })
  }

  if (s.config?.env) {
    plan.push({
      kind: 'cmd',
      title: 'kit env sync',
      cmd: [...s.self, 'env', 'sync'],
      cwd: s.root,
      env: { KIT_ROOT: s.root },
    })
  }

  for (const [name, t] of Object.entries(s.config?.targets ?? {})) {
    if (t.kind !== 'worker') continue
    if (!WRANGLER_CONFIGS.some((f) => s.exists(join(t.dir, f)))) continue
    const cwd = join(s.root, t.dir)
    plan.push({ kind: 'cmd', title: `wrangler types (${name})`, cmd: s.exec(cwd, 'wrangler', 'types'), cwd })
  }
  plan.push(...planNative(s))
  if (s.completion) {
    const { shell, file, rc, skip } = s.completion
    const title = `${shell} completion`
    plan.push(
      skip
        ? { kind: 'skip', title, reason: skip }
        : { kind: 'completion', title, shell, file, ...(rc ? { rc } : {}) },
    )
  }
  return plan
}

function planNative(s: InitState): InitAction[] {
  const plan: InitAction[] = []
  const which = s.which ?? (() => false)
  const gradle = s.config?.gradle
  const init = gradle?.init === undefined ? [] : [gradle.init].flat()
  if (gradle && init.length) {
    const title = `gradle ${init.join(' ')}`
    if (s.jsOnly) plan.push({ kind: 'skip', title, reason: '--js-only' })
    else if (!which('java')) plan.push({ kind: 'skip', title, reason: 'no java on PATH; install a JDK' })
    else if (s.config?.release?.android && !s.androidSdk) {
      plan.push({
        kind: 'skip',
        title,
        reason: `no Android SDK; set ANDROID_HOME, or sdk.dir in ${join(gradle.root, 'local.properties')}`,
      })
    } else {
      const gradlew = s.exists(join(gradle.root, 'gradlew')) ? './gradlew' : 'gradle'
      const cmd = [gradlew, '--console=plain', '-q', ...init]
      plan.push({ kind: 'cmd', title, cmd, cwd: join(s.root, gradle.root) })
    }
  }
  const toolchain = s.config?.toolchain
  if (toolchain) {
    // The wrapper downloads the pinned toolchain (and its JDK) on first use.
    const runs = toolchain.init === undefined ? ['--version'] : [toolchain.init].flat()
    for (const args of runs) {
      const title = `kotlin ${args}`
      if (s.jsOnly) plan.push({ kind: 'skip', title, reason: '--js-only' })
      else if (!s.exists(join(toolchain.root, 'kotlin'))) {
        plan.push({
          kind: 'skip',
          title,
          reason: `no ${join(toolchain.root, 'kotlin')}; check toolchain.root`,
        })
      } else {
        const cmd = ['./kotlin', ...args.split(/\s+/).filter(Boolean)]
        plan.push({ kind: 'cmd', title, cmd, cwd: join(s.root, toolchain.root) })
      }
    }
  }
  // Mobile releases use kit's own Gemfile (D7); otherwise install the app's Gemfile if it has one.
  const kitBundle = !!(s.config?.release?.ios || s.config?.release?.android)
  const gemDir = kitBundle
    ? '.'
    : [gradle?.root ?? toolchain?.root, '.'].find((d) => d !== undefined && s.exists(join(d, 'Gemfile')))
  if (gemDir !== undefined) {
    const title = kitBundle
      ? 'bundle install (kit fastlane)'
      : `bundle install${gemDir === '.' ? '' : ` (${gemDir})`}`
    if (s.jsOnly) plan.push({ kind: 'skip', title, reason: '--js-only' })
    else if (!which('bundle'))
      plan.push({ kind: 'skip', title, reason: 'no bundler on PATH; gem install bundler' })
    else
      plan.push({
        kind: 'cmd',
        title,
        cmd: ['bundle', 'install'],
        cwd: join(s.root, gemDir),
        ...(kitBundle ? { env: s.bundleEnv?.() ?? {} } : {}),
      })
  }
  if (s.platform === 'darwin' && s.config?.release?.ios && !s.jsOnly && !which('xcodebuild')) {
    plan.push({ kind: 'skip', title: 'Xcode', reason: 'no xcodebuild on PATH; install Xcode for iOS builds' })
  }
  return plan
}

/** kit's package root (templates live there), from src/commands or dist/. */
export function kitPackageRoot(from: string = import.meta.dir): string {
  let dir = from
  while (true) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === '@jordond/kit') return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('kit package root not found')
    dir = parent
  }
}

function hasAndroidSdk(root: string, config: KitConfig | undefined): boolean {
  if (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) return true
  const props = join(root, config?.gradle?.root ?? '.', 'local.properties')
  return existsSync(props) && /^\s*sdk\.dir\s*=/m.test(readFileSync(props, 'utf8'))
}

export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)
}

export default defineCommand({
  description: 'Set up a fresh clone, or a new repo: .env, install, env sync, wrangler types, native deps',
  group: 'Setup',
  args: {
    'js-only': { type: 'boolean', description: 'Skip the Gradle, Kotlin toolchain and bundler steps' },
    template: {
      type: 'string',
      description:
        'New repo: write the kit files first (toolchain: an existing Kotlin toolchain project; gradle)',
    },
    name: { type: 'string', description: 'App name for --template (default: the directory name)' },
  },
  examples: [
    'kit init',
    'kit init --dry-run',
    'kit init --yes       # also scaffold mise.toml and lefthook.yml',
    'kit init --js-only   # JS workspace only: no Gradle, no bundle install',
    'kit init --template toolchain   # add kit to a Kotlin toolchain project (kit goes in .kit/)',
    'kit init --template gradle --name MyApp',
  ].join('\n'),
  async run(ctx) {
    const { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import(
      'node:fs'
    )
    const { homedir, tmpdir } = await import('node:os')
    const { basename, normalize, relative } = await import('node:path')
    const pc = (await import('picocolors')).default
    const { CONFIG_FILE, installDir, loadConfig, loadConfigFile } = await import('../config/load')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { emitJson } = await import('../lib/log')
    const { detectPackageManager, pmExec } = await import('../lib/pm')
    const { run, runCapture, runQuiet } = await import('../lib/proc')
    const { confirm, text } = await import('../lib/prompt')
    const { isToolchainRepo, planScaffold, TEMPLATES } = await import('../lib/scaffold')
    type Template = (typeof TEMPLATES)[number]
    type FileAction = ReturnType<typeof planScaffold>[number]

    const root = ctx.root ?? process.cwd()
    const onDisk = (p: string) => existsSync(join(root, p))
    const say = !ctx.flags.json

    // ---- new repo: which template, if any ------------------------------------------------------
    const wanted = ctx.args.template
    if (wanted !== undefined && !TEMPLATES.includes(wanted as Template)) {
      throw new KitError(
        `Unknown template "${wanted}"`,
        `Use one of: ${TEMPLATES.join(', ')}`,
        ExitCode.usage,
      )
    }
    if (wanted !== undefined && ctx.root) {
      throw new KitError(
        `${relative(process.cwd(), ctx.root) || '.'} already has a ${CONFIG_FILE}`,
        'Run `kit init` without --template to set this clone up',
        ExitCode.usage,
      )
    }
    let template = wanted as Template | undefined
    const toolchainRepo = isToolchainRepo(onDisk)
    if (template === 'toolchain' && !toolchainRepo) {
      throw new KitError(
        'No Kotlin toolchain project here (a `kotlin` wrapper and project.yaml)',
        'Create one first (https://kotlin-toolchain.org), then re-run in its root',
        ExitCode.config,
      )
    }
    if (!ctx.root && !template) {
      if (toolchainRepo) {
        const ask = 'Kotlin toolchain project without kit. Add kit (.kit/, CI workflows, hooks)?'
        if (ctx.flags.yes || ctx.flags.dryRun) template = 'toolchain'
        else if (ctx.flags.interactive) {
          if (await confirm(ctx.flags, ask, { initial: true })) template = 'toolchain'
        } else if (say) {
          ctx.log.warn('Kotlin toolchain project without kit: re-run with `--template toolchain`')
        }
      } else if (say) {
        ctx.log.dim(`no ${CONFIG_FILE} here: \`kit init --template gradle\` scaffolds a new repo`)
      }
    }

    // ---- new repo: the files -------------------------------------------------------------------
    let config = ctx.config
    let scaffold: FileAction[] = []
    if (template) {
      const { tagSha, usesRef } = await import('../lib/kitref')
      let name = typeof ctx.args.name === 'string' && ctx.args.name ? ctx.args.name : basename(root)
      if (ctx.args.name === undefined && ctx.flags.interactive && !ctx.flags.yes && !ctx.flags.dryRun) {
        name = (await text(ctx.flags, 'App name', { initial: name })).trim() || name
      }
      // The name lands in TS, Kotlin, YAML and JSON strings.
      if (!/^[\w][\w .-]*$/.test(name)) {
        throw new KitError(
          `"${name}" cannot be the app name`,
          'Pass --name with letters, digits, spaces, dots, dashes or underscores',
          ExitCode.usage,
        )
      }
      const sha = await tagSha(pkg.version)
      if (!sha && say) {
        ctx.log.warn(`v${pkg.version} not found on GitHub: workflows pin the tag, not a commit`)
        ctx.log.dim('  › run `kit upgrade` once it is released to pin the SHA')
      }
      const dir = join(kitPackageRoot(), 'templates', template)
      const files: Record<string, string> = {}
      for (const rel of new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true, dot: true })) {
        // mise.toml goes through the mise scaffold below, which also honours an existing .mise.toml.
        if (rel !== SCAFFOLDS.mise.template) files[rel] = readFileSync(join(dir, rel), 'utf8')
      }
      scaffold = planScaffold({
        template,
        name,
        kitVersion: pkg.version,
        kitRef: usesRef(pkg.version, sha),
        zod: pkg.peerDependencies.zod,
        files,
        read: (p) => (onDisk(p) ? readFileSync(join(root, p), 'utf8') : undefined),
        list: (d) =>
          onDisk(d)
            ? [...new Bun.Glob('**/*').scanSync({ cwd: join(root, d), onlyFiles: true })]
                .filter((f) => !/(^|\/)(build|node_modules)\//.test(f))
                .map((f) => join(d, f))
            : [],
      })
      const configAction = scaffold.find((a) => basename(a.path) === CONFIG_FILE)
      if (ctx.flags.dryRun && configAction?.kind === 'write') {
        // Nothing is written on a dry run; validate and plan from a throwaway copy.
        const tmp = mkdtempSync(join(tmpdir(), 'kit-init-'))
        try {
          writeFileSync(join(tmp, CONFIG_FILE), configAction.content)
          config = await loadConfigFile(join(tmp, CONFIG_FILE), configAction.path)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      }
    }
    const planned = new Set(scaffold.filter((a) => a.kind !== 'skip').map((a) => normalize(a.path)))
    const exists = (p: string) => planned.has(normalize(p)) || onDisk(p)

    const describe = (a: FileAction) =>
      a.kind === 'write' ? `write ${a.path}` : a.kind === 'edit' ? `edit ${a.path}  ${pc.dim(a.note)}` : ''
    const results: { title: string; ok: boolean; skipped?: string; ms?: number }[] = []
    const started = performance.now()
    if (!ctx.flags.dryRun) {
      for (const a of scaffold) {
        if (a.kind === 'skip') {
          if (say) ctx.log.dim(`- ${a.path}  ${a.reason}`)
          results.push({ title: a.path, ok: true, skipped: a.reason })
          continue
        }
        if (say) ctx.log.step(describe(a))
        mkdirSync(join(root, a.path, '..'), { recursive: true })
        writeFileSync(join(root, a.path), a.content)
        results.push({ title: a.path, ok: true })
      }
      if (template) config = await loadConfig(root)
    }

    // ---- the clone setup -----------------------------------------------------------------------
    const pm = detectPackageManager(root, root)
    const missing = (Object.keys(SCAFFOLDS) as Scaffold[]).filter((n) =>
      [SCAFFOLDS[n].file, ...SCAFFOLDS[n].alt].every((f) => !exists(f)),
    )

    // Answers first, before anything runs. A template includes both scaffolds.
    const accepted: Scaffold[] = []
    let declinedReason: string | undefined
    if (ctx.flags.yes || template) accepted.push(...missing)
    else if (!ctx.flags.interactive) declinedReason = 'no terminal; re-run with --yes to add it'
    else if (ctx.flags.dryRun) declinedReason = 'would ask'
    else {
      for (const n of missing) {
        if (await confirm(ctx.flags, `Add ${SCAFFOLDS[n].file}?`, { initial: true })) accepted.push(n)
      }
    }

    // Shell completion lives in the home dir, so it is asked for, and never touched in CI.
    const { completionInstalled, completionTargets, rcSnippet, shellOf } = await import('../lib/completion')
    let completion: CompletionState | undefined
    const shell = shellOf(process.env.SHELL)
    if (shell && !ctx.flags.ci) {
      const home = homedir()
      const targets = completionTargets(shell, process.env, home, process.platform)
      const tilde = (f: string) => (f.startsWith(`${home}/`) ? `~/${relative(home, f)}` : f)
      const shown = tilde(targets.rc ?? targets.script)
      const current = targets.rc
        ? existsSync(targets.rc)
          ? readFileSync(targets.rc, 'utf8')
          : undefined
        : existsSync(targets.script)
          ? ''
          : undefined
      let skip: string | undefined
      if (completionInstalled(current, !!targets.rc)) skip = `already in ${shown}`
      else if (!Bun.which('kit')) skip = 'kit is not on PATH; bun add -g @jordond/kit, then re-run'
      else if (ctx.flags.dryRun && !ctx.flags.yes) skip = 'would ask'
      else if (!ctx.flags.yes && !ctx.flags.interactive) skip = 'no terminal; re-run with --yes to install it'
      else if (
        !(await confirm(ctx.flags, `Install kit completion for ${shell} (${shown})?`, { initial: true }))
      )
        skip = 'declined'
      completion = { shell, file: targets.script, rc: targets.rc, skip }
    }

    const { bundleEnv } = await import('../lib/fastlane')
    const self = [process.execPath, '--no-env-file', process.argv[1]!]
    const plan = planInit({
      root,
      config,
      exists,
      pm,
      accepted,
      declinedReason,
      self,
      exec: (cwd, bin, ...args) => pmExec(detectPackageManager(cwd, root), bin, ...args),
      which: (bin) => Bun.which(bin) !== null,
      androidSdk: hasAndroidSdk(root, config),
      platform: process.platform,
      bundleEnv,
      jsOnly: ctx.args['js-only'] === true,
      completion,
    })

    const where = (cwd: string) => relative(root, cwd) || '.'
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) {
        emitJson({
          ...(template
            ? {
                template,
                files: scaffold.map((a) =>
                  a.kind === 'skip'
                    ? a
                    : { kind: a.kind, path: a.path, ...(a.kind === 'edit' ? { note: a.note } : {}) },
                ),
              }
            : {}),
          plan: plan.map((a) =>
            a.kind === 'cmd' ? { kind: a.kind, title: a.title, cmd: a.cmd, cwd: where(a.cwd) } : a,
          ),
        })
        return
      }
      for (const a of scaffold) {
        if (a.kind === 'skip') ctx.log.dim(`- ${a.path}  ${a.reason}`)
        else ctx.log.step(describe(a))
      }
      for (const a of plan) {
        if (a.kind === 'skip') ctx.log.dim(`- ${a.title}  ${a.reason}`)
        else if (a.kind === 'cmd')
          ctx.log.step(`${a.title}  ${pc.dim(`${where(a.cwd)} $ ${a.cmd.join(' ')}`)}`)
        else if (a.kind === 'completion') ctx.log.step(`${a.title}  ${pc.dim(a.rc ?? a.file)}`)
        else ctx.log.step(a.kind === 'scaffold' ? `write ${a.title}` : `create ${a.title}`)
      }
      return
    }

    const toolchain = !!config?.toolchain || toolchainRepo
    for (const a of plan) {
      if (a.kind === 'skip') {
        if (say) ctx.log.dim(`- ${a.title}  ${a.reason}`)
        results.push({ title: a.title, ok: true, skipped: a.reason })
        continue
      }
      if (say) ctx.log.step(a.title)
      const stepStarted = performance.now()
      let ok = true
      if (a.kind === 'env-file') {
        // Secrets go in here: owner-only from creation, never the example's (usually 0644) mode.
        const dotenv = join(root, '.env')
        writeFileSync(dotenv, readFileSync(join(root, '.env.example')), { mode: 0o600 })
        chmodSync(dotenv, 0o600)
        if (say) ctx.log.dim('  fill in the values, then run `kit doctor`')
      } else if (a.kind === 'scaffold') {
        const file = join(kitPackageRoot(), 'templates', scaffoldTemplate(a.scaffold, toolchain))
        const vars = { bun: Bun.version, kit: hookKit(installDir(root)) }
        writeFileSync(
          join(root, SCAFFOLDS[a.scaffold].file),
          renderTemplate(readFileSync(file, 'utf8'), vars),
        )
      } else if (a.kind === 'completion') {
        // A static script: no kit process (and no repo config) runs when a shell starts.
        const script = await runCapture([...self, 'completion', a.shell], { cwd: homedir() })
        ok = script.code === 0 && script.stdout.trim() !== ''
        if (ok) {
          mkdirSync(join(a.file, '..'), { recursive: true })
          writeFileSync(a.file, script.stdout)
          if (a.rc) {
            const rc = existsSync(a.rc) ? readFileSync(a.rc, 'utf8') : ''
            const lead = rc === '' || rc.endsWith('\n') ? '' : '\n'
            appendFileSync(a.rc, `${lead}${rc === '' ? '' : '\n'}${rcSnippet(a.shell, a.file)}`)
          }
        }
        if (ok && say) ctx.log.dim('  open a new shell to use it')
        if (!ok && say) ctx.log.error(`${a.title} failed`)
      } else {
        // --json keeps stdout for the one document, so child output is captured instead.
        const code = ctx.flags.json
          ? (await runQuiet(a.cmd, { cwd: a.cwd, env: a.env })).code
          : await run(a.cmd, { cwd: a.cwd, env: a.env })
        ok = code === 0
        if (!ok && say) ctx.log.error(`${a.title} failed (exit ${code})`)
      }
      results.push({ title: a.title, ok, ms: Math.round(performance.now() - stepStarted) })
    }

    const failed = results.filter((r) => !r.ok).map((r) => r.title)
    if (ctx.flags.json)
      emitJson({
        ok: !failed.length,
        ...(template ? { template } : {}),
        steps: results,
        ms: Math.round(performance.now() - started),
      })
    else if (failed.length) ctx.log.error(`init failed: ${failed.join(', ')}`)
    else ctx.log.success('init complete')
    if (failed.length) process.exitCode = 1
  },
})
