import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, resolve } from 'node:path'
import type { KitConfig } from '../config/schema'
import { ExitCode, KitError } from './errors'

/**
 * Where an app module lives and what the build tool calls it. These are two facts: the Kotlin
 * toolchain names a module after its directory's basename (`mobile/android` is `-m android`), and
 * Gradle names a project by its path (`:apps:android`), whose directory is `apps/android` only by
 * default. `resolveModule` is the one place that goes from a config value to both; no caller joins
 * a module path or builds a `-m` argument or a Gradle task prefix itself.
 */

/** A `module` value in kit.config.ts: a location, or a location with the build-tool name stated. */
export type ModuleRef = string | { path: string; name?: string }

export type ModuleKind = 'toolchain' | 'gradle'

export interface ResolvedModule {
  kind: ModuleKind
  /** Config key the value came from (`release.android.module`), for errors. */
  key: string
  /** Module directory, repo-relative. */
  dir: string
  /** What the build tool is given: `-m <name>` (toolchain) or the project path `:a:b` (Gradle). */
  name: string
}

/** The native build `module` values are read against: Gradle when both are configured. */
export function moduleKind(config: KitConfig): ModuleKind | undefined {
  return config.gradle ? 'gradle' : config.toolchain ? 'toolchain' : undefined
}

function buildRoot(config: KitConfig, kind: ModuleKind): string {
  return (kind === 'gradle' ? config.gradle?.root : config.toolchain?.root) ?? '.'
}

/**
 * Location and build-tool name of a module.
 *
 * The location is `path` (or the string form), relative to the build root (`toolchain.root` or
 * `gradle.root`). A Gradle project path (`:apps:android`) is also accepted as a location: its
 * directory is `apps/android`, Gradle's default.
 *
 * The name is `name` when the config states it. Otherwise it follows the build tool's own rule:
 * the directory's basename for the Kotlin toolchain, the project path for Gradle (`apps/android`
 * is `:apps:android`).
 */
export function resolveModule(
  root: string,
  config: KitConfig,
  ref: ModuleRef,
  key: string,
  kind: ModuleKind | undefined = moduleKind(config),
): ResolvedModule {
  if (!kind) {
    throw new KitError(
      'kit.config.ts sets neither gradle nor toolchain',
      `Set gradle.root or toolchain.root: ${key} names a module of one of them`,
      ExitCode.config,
    )
  }
  const raw = (typeof ref === 'string' ? ref : ref.path).trim()
  const stated = typeof ref === 'string' ? undefined : ref.name?.trim()
  const where = typeof ref === 'string' ? key : `${key}.path`
  if (raw === '' || raw === ':') {
    throw new KitError(
      `${where} is empty`,
      `Set it to the module's directory relative to ${kind}.root`,
      ExitCode.config,
    )
  }
  const gradlePath = raw.startsWith(':')
  const path = normalize(gradlePath ? raw.slice(1).replaceAll(':', '/') : raw).replace(/\/+$/, '') || '.'
  if (isAbsolute(path)) {
    throw new KitError(
      `${where} is an absolute path (${raw})`,
      `Set it to the module's directory relative to ${kind}.root`,
      ExitCode.config,
    )
  }
  const dir = normalize(join(buildRoot(config, kind), path))
  let name = stated
  if (!name) {
    name =
      kind === 'toolchain' ? basename(resolve(root, dir)) : gradlePath ? raw : `:${path.split('/').join(':')}`
  } else if (kind === 'gradle' && !name.startsWith(':')) {
    name = `:${name}`
  }
  return { kind, key, dir, name }
}

/** `release.android.module`, or undefined when the config has no Android release. */
export function releaseAndroidModule(
  root: string,
  config: KitConfig,
  kind?: ModuleKind,
): ResolvedModule | undefined {
  const ref = config.release?.android?.module
  return ref === undefined ? undefined : resolveModule(root, config, ref, 'release.android.module', kind)
}

/** The module `kit app` builds for Android: `app.android.module`, else `release.android.module`. */
export function appAndroidModule(root: string, config: KitConfig): ResolvedModule {
  const app = config.app?.android?.module
  const ref = app ?? config.release?.android?.module
  if (ref === undefined) {
    throw new KitError(
      'kit.config.ts sets no app.android.module',
      'Set app.android.module, or release.android.module which it falls back to',
      ExitCode.config,
    )
  }
  return resolveModule(root, config, ref, app !== undefined ? 'app.android.module' : 'release.android.module')
}

/**
 * The Kotlin toolchain module `kit app` builds for iOS: `app.ios.module`, else the directory
 * holding the Xcode project (`project` is repo-relative, so that directory is used as it is).
 */
export function appIosModule(root: string, config: KitConfig, project: string): ResolvedModule {
  const ref = config.app?.ios?.module
  if (ref !== undefined) return resolveModule(root, config, ref, 'app.ios.module', 'toolchain')
  const dir = normalize(join(project, '..'))
  const key = config.app?.ios?.project ? 'app.ios.project' : 'release.ios.project'
  return { kind: 'toolchain', key, dir, name: basename(resolve(root, dir)) }
}

/** `<toolchain root>/build/tasks/_<module name>_<task>`: where the toolchain puts a task's output. */
export function toolchainTaskDir(toolchainDir: string, module: ResolvedModule, task = ''): string {
  return join(toolchainDir, 'build', 'tasks', `_${module.name}_${task}`)
}

/** Repo-relative `module.yaml` of a toolchain module. */
export function moduleYaml(module: ResolvedModule): string {
  return join(module.dir, 'module.yaml')
}

/** Entries of `modules:` in a project.yaml (block or flow list), globs included, `./` and `/` trimmed. */
export function projectModuleEntries(projectYaml: string): string[] {
  const lines = projectYaml.split('\n')
  const start = lines.findIndex((l) => /^modules\s*:/.test(l))
  if (start < 0) return []
  const clean = (raw: string) =>
    raw
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '')
  const valid = (v: string) => v !== '' && !/[{:]/.test(v)
  const flow = lines[start]!.match(/^modules\s*:\s*\[(.*)\]/)
  if (flow) return flow[1]!.split(',').map(clean).filter(valid)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const m = line.match(/^\s*-\s*(.+?)\s*$/)
    if (!m) break
    const value = clean(m[1]!.replace(/\s+#.*$/, ''))
    if (valid(value)) out.push(value)
  }
  return out
}

/**
 * Module paths listed under `modules:` in a project.yaml, relative to the toolchain root, at any
 * depth. Globs are left out; `expandProjectModules` resolves them.
 */
export function projectModules(projectYaml: string): string[] {
  return projectModuleEntries(projectYaml).filter((v) => !v.includes('*'))
}

/**
 * `projectModules` with globs (`mobile/*`, `libs/**`) expanded to the directories holding a
 * module.yaml. `list(dir)` returns the files under a directory, relative to the toolchain root.
 */
export function expandProjectModules(projectYaml: string, list: (dir: string) => string[]): string[] {
  const out: string[] = []
  for (const entry of projectModuleEntries(projectYaml)) {
    if (!entry.includes('*')) {
      out.push(entry)
      continue
    }
    const segments = entry.split('/')
    const base =
      segments
        .slice(
          0,
          segments.findIndex((s) => s.includes('*')),
        )
        .join('/') || '.'
    const pattern = entry
      .split('/')
      .map((s) => (s === '**' ? '.*' : s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')))
      .join('/')
    const re = new RegExp(`^(${pattern})/module\\.yaml$`)
    const found = list(base).flatMap((f) => normalize(f).match(re)?.[1] ?? [])
    out.push(...found.sort())
  }
  return [...new Set(out)]
}

function listedModules(root: string, config: KitConfig): string[] {
  const file = join(root, config.toolchain?.root ?? '.', 'project.yaml')
  return existsSync(file) ? projectModules(readFileSync(file, 'utf8')) : []
}

/**
 * Fail unless a Kotlin toolchain module has its `module.yaml`. The error names the path checked,
 * the name the build tool would get, and the config key to change. Gradle modules pass: a project's
 * directory can be remapped in settings.gradle, so kit does not second-guess it.
 */
export function requireModule(root: string, config: KitConfig, module: ResolvedModule): ResolvedModule {
  if (module.kind !== 'toolchain') return module
  const yaml = moduleYaml(module)
  if (existsSync(join(root, yaml))) return module
  const listed = listedModules(root, config)
  const from = module.key.endsWith('.project') ? `the directory of ${module.key}` : module.key
  const fix = module.key.endsWith('.project')
    ? 'Set app.ios.module to the module directory, relative to toolchain.root'
    : `Set ${module.key} to the module directory, relative to toolchain.root` +
      " (or { path, name } when the toolchain's module name is not the directory name)"
  throw new KitError(
    `Kotlin toolchain module not found: ${yaml} does not exist`,
    [
      `Checked ${yaml} (from ${from}); the build would be given \`-m ${module.name}\`.`,
      `${fix}.`,
      ...(listed.length ? [`project.yaml lists: ${listed.join(', ')}`] : []),
    ].join(' '),
    ExitCode.config,
  )
}
