import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defineCommand } from '../cli/command'
import type { KitConfig } from '../config/schema'
import type { PackageManager } from '../lib/pm'

/**
 * `kit init`, existing-repo mode (brewd `cli init` + WhaleSay `ws init`, generalized): `.env` from
 * `.env.example`, install, optional mise/lefthook scaffolds, `kit env sync`, `wrangler types`, then
 * the native side: `gradle.init` tasks (needs java, and an Android SDK when release.android is set)
 * and `bundle install` where a Gemfile is (the Gradle root, else the repo root). A missing tool
 * skips its step with a hint instead of failing, so a JS-only machine still ends up set up.
 * Idempotent: whatever is already there is skipped. Every step runs even after a failure, so one
 * pass surfaces every problem; the exit code is 1 if any failed. New-repo scaffolding is Phase 2.
 */

export type Scaffold = 'mise' | 'lefthook'

export const SCAFFOLDS: Record<Scaffold, { file: string; alt: string[]; template: string }> = {
  mise: { file: 'mise.toml', alt: ['.mise.toml'], template: 'mise.toml' },
  lefthook: { file: 'lefthook.yml', alt: ['lefthook.yaml', '.lefthook.yml'], template: 'lefthook.yml' },
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
  /** ANDROID_HOME / ANDROID_SDK_ROOT set, or sdk.dir in `<gradle root>/local.properties`. */
  androidSdk?: boolean
  platform?: NodeJS.Platform
  /** `--js-only`: skip the Gradle and bundler steps. */
  jsOnly?: boolean
}

export type InitAction =
  | { kind: 'env-file'; title: string }
  | { kind: 'scaffold'; title: string; scaffold: Scaffold }
  | { kind: 'cmd'; title: string; cmd: string[]; cwd: string; env?: Record<string, string> }
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
  } else plan.push({ kind: 'skip', title: 'install', reason: 'no package.json' })

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
  const gemDir = [gradle?.root, '.'].find((d) => d !== undefined && s.exists(join(d, 'Gemfile')))
  if (gemDir !== undefined) {
    const title = `bundle install${gemDir === '.' ? '' : ` (${gemDir})`}`
    if (s.jsOnly) plan.push({ kind: 'skip', title, reason: '--js-only' })
    else if (!which('bundle'))
      plan.push({ kind: 'skip', title, reason: 'no bundler on PATH; gem install bundler' })
    else plan.push({ kind: 'cmd', title, cmd: ['bundle', 'install'], cwd: join(s.root, gemDir) })
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
  description: 'Set up a fresh clone: .env, install, env sync, wrangler types, Gradle and bundler deps',
  group: 'Setup',
  args: {
    'js-only': { type: 'boolean', description: 'Skip the Gradle and bundler steps' },
  },
  examples: [
    'kit init',
    'kit init --dry-run',
    'kit init --yes       # also scaffold mise.toml and lefthook.yml',
    'kit init --js-only   # JS workspace only: no Gradle, no bundle install',
  ].join('\n'),
  async run(ctx) {
    const { chmodSync, writeFileSync } = await import('node:fs')
    const { relative } = await import('node:path')
    const pc = (await import('picocolors')).default
    const { emitJson } = await import('../lib/log')
    const { detectPackageManager, pmExec } = await import('../lib/pm')
    const { run, runQuiet } = await import('../lib/proc')
    const { confirm } = await import('../lib/prompt')

    const root = ctx.root ?? process.cwd()
    const exists = (p: string) => existsSync(join(root, p))
    const pm = detectPackageManager(root, root)
    const missing = (Object.keys(SCAFFOLDS) as Scaffold[]).filter((n) =>
      [SCAFFOLDS[n].file, ...SCAFFOLDS[n].alt].every((f) => !exists(f)),
    )

    // Answers first, before anything runs.
    const accepted: Scaffold[] = []
    let declinedReason: string | undefined
    if (ctx.flags.yes) accepted.push(...missing)
    else if (!ctx.flags.interactive) declinedReason = 'no terminal; re-run with --yes to add it'
    else if (ctx.flags.dryRun) declinedReason = 'would ask'
    else {
      for (const n of missing) {
        if (await confirm(ctx.flags, `Add ${SCAFFOLDS[n].file}?`, { initial: true })) accepted.push(n)
      }
    }

    const plan = planInit({
      root,
      config: ctx.config,
      exists,
      pm,
      accepted,
      declinedReason,
      self: [process.execPath, '--no-env-file', process.argv[1]!],
      exec: (cwd, bin, ...args) => pmExec(detectPackageManager(cwd, root), bin, ...args),
      which: (bin) => Bun.which(bin) !== null,
      androidSdk: hasAndroidSdk(root, ctx.config),
      platform: process.platform,
      jsOnly: ctx.args['js-only'] === true,
    })

    const where = (cwd: string) => relative(root, cwd) || '.'
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) {
        emitJson({
          plan: plan.map((a) =>
            a.kind === 'cmd' ? { kind: a.kind, title: a.title, cmd: a.cmd, cwd: where(a.cwd) } : a,
          ),
        })
        return
      }
      for (const a of plan) {
        if (a.kind === 'skip') ctx.log.dim(`- ${a.title}  ${a.reason}`)
        else if (a.kind === 'cmd')
          ctx.log.step(`${a.title}  ${pc.dim(`${where(a.cwd)} $ ${a.cmd.join(' ')}`)}`)
        else ctx.log.step(a.kind === 'scaffold' ? `write ${a.title}` : `create ${a.title}`)
      }
      return
    }

    const results: { title: string; ok: boolean; skipped?: string }[] = []
    const kitRoot = ctx.flags.json ? undefined : kitPackageRoot()
    for (const a of plan) {
      if (a.kind === 'skip') {
        if (!ctx.flags.json) ctx.log.dim(`- ${a.title}  ${a.reason}`)
        results.push({ title: a.title, ok: true, skipped: a.reason })
        continue
      }
      if (!ctx.flags.json) ctx.log.step(a.title)
      let ok = true
      if (a.kind === 'env-file') {
        // Secrets go in here: owner-only from creation, never the example's (usually 0644) mode.
        const dotenv = join(root, '.env')
        writeFileSync(dotenv, readFileSync(join(root, '.env.example')), { mode: 0o600 })
        chmodSync(dotenv, 0o600)
        if (!ctx.flags.json) ctx.log.dim('  fill in the values, then run `kit doctor`')
      } else if (a.kind === 'scaffold') {
        const { file, template } = SCAFFOLDS[a.scaffold]
        const text = readFileSync(join(kitRoot ?? kitPackageRoot(), 'templates', template), 'utf8')
        writeFileSync(join(root, file), renderTemplate(text, { bun: Bun.version }))
      } else {
        // --json keeps stdout for the one document, so child output is captured instead.
        const code = ctx.flags.json
          ? (await runQuiet(a.cmd, { cwd: a.cwd, env: a.env })).code
          : await run(a.cmd, { cwd: a.cwd, env: a.env })
        ok = code === 0
        if (!ok && !ctx.flags.json) ctx.log.error(`${a.title} failed (exit ${code})`)
      }
      results.push({ title: a.title, ok })
    }

    const failed = results.filter((r) => !r.ok).map((r) => r.title)
    if (ctx.flags.json) emitJson({ ok: !failed.length, steps: results })
    else if (failed.length) ctx.log.error(`init failed: ${failed.join(', ')}`)
    else ctx.log.success('init complete')
    if (failed.length) process.exitCode = 1
  },
})
