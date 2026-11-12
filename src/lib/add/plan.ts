import { join, normalize } from 'node:path'
import { ExitCode, KitError } from '../errors'
import { type FileAction, fill, type ReadFile } from '../scaffold'
import { withInclude, withProjectModule, withTarget } from './edits'

/**
 * Plans for `kit add module` and `kit add target`: the files to write and the one-line edits to
 * settings.gradle.kts, project.yaml or kit.config.ts. Pure: the repo comes in through `read`, the
 * templates (kit's `templates/add/`) through `templates`, and nothing is written here.
 */

export const MODULE_TARGETS = ['android', 'ios', 'jvm', 'js'] as const
export type ModuleTarget = (typeof MODULE_TARGETS)[number]
export const DEFAULT_MODULE_TARGETS: ModuleTarget[] = ['android', 'ios', 'jvm']

/** Target kinds `kit add target` registers; gradle and kotlin targets come from `kit init`. */
export const ADD_KINDS = ['worker', 'vite', 'astro', 'docker', 'custom'] as const
export type AddKind = (typeof ADD_KINDS)[number]

export interface AddPlan {
  actions: FileAction[]
  /** Files the plan would write that already exist: refused without `--force`. */
  conflicts: string[]
  /** An edit kit will not make by text: `snippet` goes into `file` by hand. Nothing is written. */
  manual?: { file: string; where: string; snippet: string }
}

/** One Gradle project name: a letter first, then letters, digits, `_`, and single dashes. */
const SEGMENT = /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*$/

/**
 * `feature:login` (or `:feature:login`) → ['feature', 'login']. Segments follow Gradle's project
 * name rules, narrowed to what also maps to a directory and a Kotlin package.
 */
export function parseModulePath(name: string, nested = true): string[] {
  const segments = name.replace(/^:/, '').split(':')
  const bad = segments.find((s) => !SEGMENT.test(s))
  if (name === '' || bad !== undefined || (!nested && segments.length > 1)) {
    throw new KitError(
      `"${name}" cannot be a module name`,
      nested
        ? 'Use letters, digits, dashes and underscores, starting with a letter; `:` nests (feature:login)'
        : 'Use letters, digits, dashes and underscores, starting with a letter',
      ExitCode.usage,
    )
  }
  return segments
}

/** `--targets android,ios` → the list, in kit's order; undefined → the default. */
export function parseModuleTargets(raw: string | undefined): ModuleTarget[] {
  if (raw === undefined) return DEFAULT_MODULE_TARGETS
  const wanted = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const unknown = wanted.filter((t) => !(MODULE_TARGETS as readonly string[]).includes(t))
  if (!wanted.length || unknown.length) {
    throw new KitError(
      unknown.length ? `Unknown module target "${unknown[0]}"` : '--targets needs at least one target',
      `Use a comma-separated list of: ${MODULE_TARGETS.join(', ')}`,
      ExitCode.usage,
    )
  }
  return MODULE_TARGETS.filter((t) => wanted.includes(t))
}

/**
 * The package of a module, derived exactly like the kmp.library plugin's Android namespace
 * (gradle/plugins/…/KitNamespaces.kt `forPath`): `<app-name>.<module path>`, each path segment
 * split on `-` and `.`, lowercased, other characters `_`, a leading digit prefixed with `_`.
 */
export function modulePackage(appName: string, segments: string[]): string {
  const parts = segments
    .flatMap((s) => s.split(/[-.]/))
    .map((s) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
    .map((s) => (/^[0-9]/.test(s) ? `_${s}` : s))
  return [appName, ...parts].join('.')
}

const KOTLIN_HARD_KEYWORDS = new Set(
  'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'.split(
    ' ',
  ),
)

/** The package as written after `package` in a Kotlin file: hard keywords in backticks. */
export function kotlinPackage(pkg: string): string {
  return pkg
    .split('.')
    .map((s) => (KOTLIN_HARD_KEYWORDS.has(s) ? `\`${s}\`` : s))
    .join('.')
}

/** A repo-relative directory inside the repo, normalised (`./apps/api/` → `apps/api`). */
export function parseDir(dir: string, flag = '--dir'): string {
  const clean = normalize(dir).replace(/\/+$/, '')
  if (dir.trim() === '' || clean.startsWith('/') || clean === '..' || clean.startsWith('../')) {
    throw new KitError(`${flag} "${dir}" is not a directory inside the repo`, undefined, ExitCode.usage)
  }
  return clean
}

/** Existing files become conflicts (or overwrites with `force`); the rest are writes. */
function writes(files: [string, string][], read: ReadFile, force: boolean): AddPlan {
  const actions: FileAction[] = []
  const conflicts: string[] = []
  for (const [path, content] of files) {
    if (read(path) !== undefined && !force) conflicts.push(path)
    else actions.push({ kind: 'write', path, content })
  }
  return { actions, conflicts }
}

/** Fill a template; a placeholder left over is a bug in kit, not something to write to a repo. */
function render(templates: Record<string, string>, file: string, vars: Record<string, string>): string {
  const text = templates[file]
  if (text === undefined) throw new Error(`kit template add/${file} is missing`)
  const out = fill(text, vars)
  const left = out.match(/\{\{\w+\}\}/)
  if (left) throw new Error(`kit template add/${file}: no value for ${left[0]}`)
  return out
}

export interface ModuleInput {
  /** Path segments from `parseModulePath`. */
  segments: string[]
  targets: ModuleTarget[]
  compose: boolean
  /** Module directory relative to the Gradle or toolchain root; default: the path as directories. */
  dir?: string
  /** The Gradle root (`gradle.root`) or toolchain root (`toolchain.root`), repo-relative. */
  root: string
  /** What packages start with: catalog `app-name` (Gradle), the app's id (toolchain). */
  appName: string
  templates: Record<string, string>
  read: ReadFile
  force?: boolean
}

/**
 * A KMP library module on kit's Gradle plugins: build.gradle.kts, one placeholder under
 * commonMain in the package the plugin derives as the namespace, and the `include` in `settings`
 * (the repo-relative settings file).
 */
export function planGradleModule(input: ModuleInput & { settings: string }): AddPlan {
  const { segments, root, read } = input
  const path = segments.join(':')
  const natural = segments.join('/')
  const dir = input.dir ?? natural
  const pkg = modulePackage(input.appName, segments)
  const plan = writes(
    [
      [
        join(root, dir, 'build.gradle.kts'),
        render(input.templates, 'gradle-module/build.gradle.kts', {
          compose: input.compose ? '\n    id("io.github.jordond.kit.compose")' : '',
          targets: input.targets.map((t) => `        ${t}()`).join('\n'),
        }),
      ],
      [
        join(root, dir, 'src/commonMain/kotlin', ...pkg.split('.'), 'Placeholder.kt'),
        render(input.templates, 'Placeholder.kt', { package: kotlinPackage(pkg), module: `:${path}` }),
      ],
    ],
    read,
    input.force === true,
  )
  const settings = read(input.settings)
  const edited =
    settings === undefined ? undefined : withInclude(settings, path, dir === natural ? undefined : dir)
  plan.actions.push(
    edited === undefined
      ? { kind: 'skip', path: input.settings, reason: `already includes :${path}` }
      : { kind: 'edit', path: input.settings, content: edited, note: `include(":${path}")` },
  )
  return plan
}

/** Amper platform names of a kit module target. */
const TOOLCHAIN_PLATFORMS: Record<ModuleTarget, string[]> = {
  android: ['android'],
  ios: ['iosArm64', 'iosSimulatorArm64'],
  jvm: ['jvm'],
  js: ['js'],
}

/**
 * A `kmp/lib` module for a Kotlin toolchain project: module.yaml, one placeholder under `src/`,
 * and the entry in project.yaml.
 */
export function planToolchainModule(input: ModuleInput): AddPlan {
  const { segments, root, read } = input
  const name = segments.join('/')
  const dir = input.dir ?? name
  const pkg = modulePackage(input.appName, segments)
  const yaml = render(input.templates, 'toolchain-module/module.yaml', {
    platforms: input.targets.flatMap((t) => TOOLCHAIN_PLATFORMS[t]).join(', '),
    settings: input.compose ? '\nsettings:\n  compose:\n    enabled: true' : '',
  })
  const plan = writes(
    [
      [join(root, dir, 'module.yaml'), `${yaml.trimEnd()}\n`],
      [
        join(root, dir, 'src/Placeholder.kt'),
        render(input.templates, 'Placeholder.kt', { package: kotlinPackage(pkg), module: name }),
      ],
    ],
    read,
    input.force === true,
  )
  const project = join(root, 'project.yaml')
  const edited = withProjectModule(read(project) ?? '', dir)
  if (edited === 'manual') {
    return { ...plan, manual: { file: project, where: 'the `modules:` list', snippet: `- ${dir}` } }
  }
  plan.actions.push(
    edited === undefined
      ? { kind: 'skip', path: project, reason: `already lists ${dir}` }
      : { kind: 'edit', path: project, content: edited, note: `add ${dir} to modules` },
  )
  return plan
}

/**
 * A target name: a letter first, then letters, digits, `-` and `_`. It is typed after a verb
 * (`kit build api`), so it cannot be `workspace`, an existing target, or a kit command.
 */
export function validateTargetName(name: string, existing: string[], commands: string[]): void {
  const fail = (message: string, hint?: string) => {
    throw new KitError(message, hint, ExitCode.usage)
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    fail(
      `"${name}" cannot be a target name`,
      'Use letters, digits, dashes and underscores, starting with a letter',
    )
  }
  if (name === 'workspace') fail('"workspace" is reserved', 'It names the repo-wide steps')
  if (existing.includes(name)) fail(`Target "${name}" already exists`, `Targets: ${existing.join(', ')}`)
  if (commands.includes(name)) fail(`"${name}" is a kit command`, 'Pick a name that is not a command')
}

export interface TargetInput {
  name: string
  kind: AddKind
  /** Repo-relative, from `parseDir`. */
  dir: string
  /** The repo's config file, repo-relative (`kit.config.ts` or `.kit/kit.config.ts`). */
  configFile: string
  /** Whether a repo-relative path exists (a directory counts). */
  exists: (repoPath: string) => boolean
  /** `YYYY-MM-DD` for a new worker's `compatibility_date`. */
  date: string
  templates: Record<string, string>
  read: ReadFile
}

const WORKER_FILES = ['package.json', 'src/index.ts', 'tsconfig.json', 'wrangler.jsonc']

/**
 * The target in kit.config.ts, plus its directory when missing: a minimal worker for `worker`
 * (placeholder name, no account id), an empty directory (a `.gitkeep`) for the other kinds.
 */
export function planTarget(input: TargetInput): AddPlan {
  const { name, kind, dir, configFile, read } = input
  const text = read(configFile)
  if (text === undefined) throw new Error(`${configFile} is missing`)
  const edit = withTarget(text, name, { kind, dir })
  if (edit.status === 'exists') {
    throw new KitError(`Target "${name}" already exists in ${configFile}`, undefined, ExitCode.usage)
  }
  if (edit.status === 'manual') {
    return {
      actions: [],
      conflicts: [],
      manual: { file: configFile, where: 'the `targets: { … }` object', snippet: edit.snippet },
    }
  }
  const actions: FileAction[] = [
    { kind: 'edit', path: configFile, content: edit.content, note: `add target ${name}` },
  ]
  if (input.exists(dir)) return { actions, conflicts: [] }
  if (kind === 'worker') {
    const vars = { worker: name.toLowerCase().replace(/_/g, '-'), date: input.date }
    for (const file of WORKER_FILES) {
      actions.push({
        kind: 'write',
        path: join(dir, file),
        content: render(input.templates, `worker/${file}`, vars),
      })
    }
  } else {
    actions.push({ kind: 'write', path: join(dir, '.gitkeep'), content: '' })
  }
  return { actions, conflicts: [] }
}
