import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { CommandValue, Kind, KitConfig, TargetConfig, Verb } from '../config/schema'
import { ExitCode, KitError } from './errors'
import { detectPackageManager, type PackageManager, packageScripts, pmExec, runScript } from './pm'
import { shell } from './proc'
import { moduleName } from './toolchain'

/**
 * Targets and kinds (PLAN §6.4). A kind maps verbs to default commands; any verb on any target can
 * be overridden in config with a command string, a list, or `false`. Repo-wide steps live under
 * `workspace`. This module only plans; running is `steps.ts`.
 */

export const WORKSPACE = 'workspace'

export interface PlannedCommand {
  title: string
  cmd: string[]
  cwd: string
  env?: Record<string, string>
}

export interface PlannedGroup {
  /** Target name, or `workspace`. */
  title: string
  commands: PlannedCommand[]
}

export interface PlanOptions {
  /** Target names from argv; empty means all. `workspace` may be named. */
  targets?: string[]
  /** Appended to every command (`kit test api -- --watch`). */
  extra?: string[]
  /** `--env` for dev and deploy. */
  env?: string
  /** Staged files (repo-relative). Workspace commands get them appended; targets without one are skipped. */
  staged?: string[]
  /**
   * `--affected`: changed files (repo-relative). Only selects: targets no changed file affects are
   * skipped, and nothing changed plans nothing. No file list reaches the tools.
   */
  affected?: string[]
  /** Gradle and kotlin targets build the release artifact instead. */
  release?: 'aab' | 'apk'
}

/** Verbs that run the workspace `prepare` commands first. */
const PREPARES: readonly Verb[] = ['lint', 'typecheck', 'test', 'build']
/** Kinds whose targets pull in the workspace when named. */
const JS_KINDS: readonly Kind[] = ['worker', 'vite', 'astro', 'custom']

export interface Selection {
  targets: [string, TargetConfig][]
  workspace: boolean
}

/** Validate target names against config. Unknown names are a usage error with a suggestion. */
export function selectTargets(config: KitConfig, names: string[] = []): Selection {
  const all = Object.entries(config.targets)
  if (!names.length) return { targets: all, workspace: true }
  const known = new Set([WORKSPACE, ...all.map(([n]) => n)])
  for (const n of names) {
    if (!known.has(n)) {
      const guess = suggest(n, [...known])
      throw new KitError(
        `Unknown target "${n}".${guess ? ` Did you mean "${guess}"?` : ''}`,
        `Targets: ${[...known].join(', ')}`,
        ExitCode.usage,
      )
    }
  }
  const targets = all.filter(([n]) => names.includes(n))
  const workspace = names.includes(WORKSPACE) || targets.some(([, t]) => JS_KINDS.includes(t.kind))
  return { targets, workspace }
}

interface Ctx {
  root: string
  config: KitConfig
  opts: PlanOptions
}

const list = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v])

/** A Gradle task name (`spotlessCheck`, `:shared:test`) rather than a shell command. */
export const isGradleTask = (s: string): boolean => /^:?[A-Za-z][\w.-]*(:[A-Za-z][\w.-]*)*$/.test(s)

/** `./kotlin <args>` in the toolchain root (else the target dir). */
function kotlinCommand(c: Ctx, target: TargetConfig, args: string[]): PlannedCommand {
  const cwd = resolve(c.root, c.config.toolchain?.root ?? target.dir)
  const extra = c.opts.extra ?? []
  return { title: `kotlin ${args.join(' ')}`, cmd: ['./kotlin', ...args, ...extra], cwd }
}

/** What `ktlint` checks with no staged list: every Kotlin file outside build output and node_modules. */
export const KTLINT_PATTERNS = ['**/*.kt', '**/*.kts', '!**/build/**', '!**/node_modules/**']

/**
 * `ktlint` (lint) or `ktlint -F` (format) in the toolchain root: the Kotlin toolchain has no
 * linter of its own. With `--staged`, only the staged Kotlin files under that dir; none = no command.
 */
function ktlintCommand(c: Ctx, target: TargetConfig, fix: boolean): PlannedCommand[] {
  const cwd = resolve(c.root, c.config.toolchain?.root ?? target.dir)
  let files = KTLINT_PATTERNS
  if (c.opts.staged) {
    files = c.opts.staged
      .filter((f) => /\.kts?$/.test(f))
      .map((f) => relative(cwd, resolve(c.root, f)))
      .filter((f) => !f.startsWith('..'))
    if (!files.length) return []
  }
  const flags = ['--relative', ...(fix ? ['-F'] : [])]
  return [
    {
      title: fix ? 'ktlint -F' : 'ktlint',
      cmd: ['ktlint', ...flags, ...files, ...(c.opts.extra ?? [])],
      cwd,
    },
  ]
}

function gradleCommand(c: Ctx, target: TargetConfig, tasks: string[]): PlannedCommand {
  const cwd = resolve(c.root, c.config.gradle?.root ?? target.dir)
  const gradlew = existsSync(join(cwd, 'gradlew')) ? './gradlew' : 'gradle'
  const extra = c.opts.extra ?? []
  return { title: `gradle ${tasks.join(' ')}`, cmd: [gradlew, ...tasks, ...extra], cwd }
}

/** Config value → commands. Strings run through `sh -c`; on gradle targets task names run through gradlew. */
function fromValue(c: Ctx, value: string | string[], cwd: string, target?: TargetConfig): PlannedCommand[] {
  const items = list(value)
  const extra = c.opts.extra ?? []
  if (target?.kind === 'gradle' && items.every(isGradleTask)) return [gradleCommand(c, target, items)]
  return items.map((s) =>
    target?.kind === 'gradle' && isGradleTask(s)
      ? gradleCommand(c, target, [s])
      : { title: s, cmd: shell(s, extra), cwd },
  )
}

function script(c: Ctx, dir: string, pm: PackageManager, name: string): PlannedCommand[] {
  const scripts = packageScripts(dir)
  if (!scripts?.[name]) return []
  const extra = c.opts.extra ?? []
  return [{ title: `${pm} run ${name}`, cmd: [...runScript(pm, name), ...extra], cwd: dir }]
}

function bin(c: Ctx, dir: string, pm: PackageManager, ...args: string[]): PlannedCommand[] {
  const cmd = [...pmExec(pm, ...(args as [string, ...string[]])), ...(c.opts.extra ?? [])]
  return [{ title: args.join(' '), cmd, cwd: dir }]
}

/** Default commands of a kind for a verb. `undefined` when the kind has none. */
function kindDefault(c: Ctx, name: string, t: TargetConfig, verb: Verb): PlannedCommand[] | undefined {
  const dir = resolve(c.root, t.dir)
  const pm = detectPackageManager(dir, c.root)
  const env = c.opts.env
  switch (t.kind) {
    case 'gradle': {
      const release = c.config.release?.android?.module
      if (verb === 'build' && c.opts.release) {
        if (!release) {
          throw new KitError(
            'A release build needs release.android.module in kit.config.ts',
            "e.g. release: { android: { module: ':android', packageName: '…' } }",
            ExitCode.config,
          )
        }
        return [
          gradleCommand(c, t, [
            `${release}:${c.opts.release === 'aab' ? 'bundleRelease' : 'assembleRelease'}`,
          ]),
        ]
      }
      const task = { lint: 'spotlessCheck', format: 'spotlessApply', test: 'test', build: 'build' }[
        verb as string
      ]
      return task ? [gradleCommand(c, t, [task])] : undefined
    }
    case 'kotlin': {
      if (verb === 'build' && c.opts.release) {
        const module = c.config.release?.android?.module
        if (c.opts.release === 'apk') {
          throw new KitError(
            'The Kotlin toolchain packages Android releases as an AAB only',
            `Use \`kit build ${name} --release\``,
            ExitCode.usage,
          )
        }
        if (!module) {
          throw new KitError(
            'A release build needs release.android.module in kit.config.ts',
            "e.g. release: { android: { module: 'androidApp', packageName: '…' } }",
            ExitCode.config,
          )
        }
        return [kotlinCommand(c, t, ['package', '-m', moduleName(module)])]
      }
      if (verb === 'lint' || verb === 'format') return ktlintCommand(c, t, verb === 'format')
      const args = { test: ['test'], build: ['build'] }[verb as string]
      return args ? [kotlinCommand(c, t, args)] : undefined
    }
    case 'worker':
      if (verb === 'test') return script(c, dir, pm, 'test')
      if (verb === 'build') return bin(c, dir, pm, 'wrangler', 'deploy', '--dry-run')
      if (verb === 'dev') return bin(c, dir, pm, 'wrangler', 'dev', ...(env ? ['--env', env] : []))
      if (verb === 'deploy') return bin(c, dir, pm, 'wrangler', 'deploy', ...(env ? ['--env', env] : []))
      return undefined
    case 'vite':
      if (verb === 'test' || verb === 'build' || verb === 'dev' || verb === 'deploy')
        return script(c, dir, pm, verb)
      return undefined
    case 'astro':
      if (verb === 'lint') return bin(c, dir, pm, 'astro', 'check')
      if (verb === 'build' || verb === 'dev') return script(c, dir, pm, verb)
      if (verb === 'deploy') return script(c, dir, pm, env ? `deploy:${env}` : 'deploy')
      return undefined
    case 'docker': {
      const image = `${c.config.name}-${name}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')
      if (verb === 'build')
        return [{ title: `docker build ${image}`, cmd: ['docker', 'build', '-t', image, '.'], cwd: dir }]
      if (verb === 'dev')
        return [{ title: `docker run ${image}`, cmd: ['docker', 'run', '--rm', '-it', image], cwd: dir }]
      return undefined
    }
    case 'custom':
      return undefined
  }
}

function targetValue(t: TargetConfig, verb: Verb): CommandValue | undefined {
  if (verb !== 'deploy') return t[verb]
  const d = t.deploy
  if (d === undefined || typeof d === 'string' || Array.isArray(d) || d === false) return d
  return d.run
}

/** Commands for one target and verb. `undefined` = the target doesn't support the verb. */
export function targetCommands(
  root: string,
  config: KitConfig,
  name: string,
  verb: Verb,
  opts: PlanOptions = {},
): PlannedCommand[] | undefined {
  const t = config.targets[name]
  if (!t) throw new KitError(`Unknown target "${name}"`, undefined, ExitCode.usage)
  const c: Ctx = { root, config, opts }
  const value = targetValue(t, verb)
  if (value === false) return undefined
  const cmds =
    value !== undefined ? fromValue(c, value, resolve(root, t.dir), t) : kindDefault(c, name, t, verb)
  if (!cmds?.length) return undefined
  if (opts.env) for (const cmd of cmds) cmd.env = { ...cmd.env, KIT_ENV: opts.env }
  return cmds
}

function workspaceCommands(c: Ctx, verb: Verb | 'prepare'): PlannedCommand[] {
  const value = c.config.workspace?.[verb]
  if (value === undefined || value === false) return []
  if (verb === 'prepare') return list(value).map((s) => ({ title: s, cmd: shell(s), cwd: c.root }))
  const staged = (verb === 'lint' || verb === 'format') && c.opts.staged ? c.opts.staged : []
  const withStaged: Ctx = { ...c, opts: { ...c.opts, extra: [...staged, ...(c.opts.extra ?? [])] } }
  return fromValue(withStaged, value, c.root)
}

/** `file` (repo-relative) is `dir` or under it. An empty `dir` is the repo root: every file. */
const under = (dir: string, file: string): boolean => !dir || file === dir || file.startsWith(`${dir}/`)

/** `targets.<name>.paths` entry: a dir (prefix match) or a glob. */
function matchesPath(root: string, entry: string, file: string): boolean {
  const dir = relative(root, resolve(root, entry))
  return (!!dir && under(dir, file)) || new Bun.Glob(entry.replace(/^\.\//, '')).match(file)
}

/**
 * Whether any of `files` (repo-relative) belongs to the target: under its `dir`, or, with
 * `paths: true` (`--affected`), matching one of its `paths`. `--staged` looks at `dir` only.
 */
export function touches(
  root: string,
  t: Pick<TargetConfig, 'dir' | 'paths'>,
  files: string[],
  opts: { paths?: boolean } = {},
): boolean {
  const dir = relative(root, resolve(root, t.dir))
  const extra = opts.paths ? (t.paths ?? []) : []
  return files.some((f) => under(dir, f) || extra.some((p) => matchesPath(root, p, f)))
}

/**
 * Targets `--affected` runs for `files` (changed files, repo-relative). A file under no target's
 * `dir` and matching no target's `paths` (root lockfile, CI, shared tooling) affects every target.
 * A target at the repo root is affected by any change but claims no file, so that rule still holds.
 */
export function affectedTargets(root: string, config: KitConfig, files: string[]): string[] {
  const all = Object.entries(config.targets)
  if (!files.length) return []
  const owned = all.filter(([, t]) => relative(root, resolve(root, t.dir)) !== '')
  const orphan = files.some((f) => !owned.some(([, t]) => touches(root, t, [f], { paths: true })))
  return all.filter(([, t]) => orphan || touches(root, t, files, { paths: true })).map(([n]) => n)
}

/**
 * Plan a run of `verbs` (one, or `check` = lint + typecheck) over the selected targets.
 * Groups: workspace first (prepare, then each verb), then each target in config order.
 */
export function planVerbs(
  root: string,
  config: KitConfig,
  verbs: Verb[],
  opts: PlanOptions = {},
): PlannedGroup[] {
  const sel = selectTargets(config, opts.targets)
  const c: Ctx = { root, config, opts }
  const groups: PlannedGroup[] = []
  const affected = opts.affected && new Set(affectedTargets(root, config, opts.affected))
  // The workspace runs whenever anything changed (or was staged).
  if (sel.workspace && !(opts.staged && !opts.staged.length) && !(opts.affected && !opts.affected.length)) {
    const commands: PlannedCommand[] = []
    if (verbs.some((v) => PREPARES.includes(v))) commands.push(...workspaceCommands(c, 'prepare'))
    // prepare runs even with no workspace verb command: target steps need the codegen too.
    commands.push(...verbs.flatMap((v) => workspaceCommands(c, v)))
    if (commands.length) groups.push({ title: WORKSPACE, commands })
  }
  for (const [name, t] of sel.targets) {
    if (opts.staged && !touches(root, t, opts.staged)) continue
    if (affected && !affected.has(name)) continue
    const commands = verbs.flatMap((v) => targetCommands(root, config, name, v, opts) ?? [])
    if (commands.length) groups.push({ title: name, commands })
  }
  return groups
}

export function suggest(token: string, candidates: string[]): string | undefined {
  const dist = (a: string, b: string) => {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
      i,
      ...Array<number>(b.length).fill(0),
    ])
    for (let j = 1; j <= b.length; j++) d[0]![j] = j
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i]![j] = Math.min(
          d[i - 1]![j]! + 1,
          d[i]![j - 1]! + 1,
          d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        )
    return d[a.length]![b.length]!
  }
  const best = candidates.map((c) => [c, dist(token, c)] as const).sort((x, y) => x[1] - y[1])[0]
  return best && best[1] <= 2 ? best[0] : undefined
}
