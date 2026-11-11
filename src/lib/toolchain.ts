import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { KitConfig } from '../config/schema'
import { ExitCode, KitError } from './errors'

/**
 * JetBrains Kotlin Toolchain (formerly Amper) support: `toolchain.root` in kit.config.ts holds the
 * `kotlin` wrapper, `project.yaml` and one `module.yaml` per module. There is no Gradle and no way
 * to pass a property on the command line, so the values a release needs (versionName, versionCode,
 * signing) are written into the app module's `module.yaml` for the build and restored after.
 */

export const WRAPPER = './kotlin'

/** `kotlin_cli_version=0.13.0` from the wrapper script. */
export function wrapperVersion(text: string): string | undefined {
  return text.match(/^\s*kotlin_cli_version\s*=\s*(\S+)\s*$/m)?.[1]
}

export function toolchainRoot(root: string, config: KitConfig): string {
  if (!config.toolchain) {
    throw new KitError(
      'No Kotlin toolchain configured',
      'Set toolchain.root in kit.config.ts',
      ExitCode.config,
    )
  }
  return resolve(root, config.toolchain.root)
}

/** Fail unless `<toolchain root>/kotlin` exists. */
export function requireWrapper(root: string, config: KitConfig): string {
  const dir = toolchainRoot(root, config)
  if (!existsSync(join(dir, 'kotlin'))) {
    throw new KitError(
      `${join(config.toolchain!.root, 'kotlin')} not found`,
      'Check toolchain.root in kit.config.ts (the dir holding the `kotlin` wrapper and project.yaml)',
      ExitCode.config,
    )
  }
  return dir
}

/**
 * `release.android.module` as a toolchain module name. Gradle-style `:androidApp` is accepted; a
 * nested `:apps:android` becomes the path `apps/android`.
 */
export function moduleName(module: string): string {
  return module.replace(/^:/, '').replaceAll(':', '/')
}

/** Repo-relative path of the module's module.yaml. */
export function moduleYamlPath(config: KitConfig, module: string): string {
  return join(config.toolchain!.root, moduleName(module), 'module.yaml')
}

// ---- module.yaml editing ----------------------------------------------------------------------
//
// A deliberately small, line-based editor: block mappings only, two or more spaces of indent,
// comments and unrelated lines untouched. Flow style (`android: { minSdk: 26 }`) on a path kit must
// descend into is a config error rather than a silent rewrite.

export type YamlValue = string | { [key: string]: string }

const indentOf = (line: string) => line.length - line.trimStart().length
const isContent = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#')

function keyRe(key: string): RegExp {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^(\\s*)(?:${k}|"${k}"|'${k}')\\s*:(?=\\s|$)(.*)$`)
}

/** End (exclusive) of the block whose header is at `i` with `indent`. */
function blockEnd(lines: string[], i: number, indent: number, end = lines.length): number {
  for (let j = i + 1; j < end; j++) if (isContent(lines[j]!) && indentOf(lines[j]!) <= indent) return j
  return end
}

/** Index of `key` directly inside [start, end) at `indent`, or -1. */
function findKey(lines: string[], start: number, end: number, indent: number, key: string): number {
  const re = keyRe(key)
  for (let j = start; j < end; j++) {
    const line = lines[j]!
    if (!isContent(line) || indentOf(line) !== indent) continue
    if (re.test(line)) return j
  }
  return -1
}

/** Indent of the children in [start, end), or `fallback`. */
function childIndent(lines: string[], start: number, end: number, fallback: number): number {
  for (let j = start; j < end; j++) if (isContent(lines[j]!)) return indentOf(lines[j]!)
  return fallback
}

/** Insertion point at the end of a block: after its last content line. */
function insertAt(lines: string[], start: number, end: number): number {
  let at = start
  for (let j = start; j < end; j++) if (isContent(lines[j]!)) at = j + 1
  return at
}

/** Inline value after `key:` with any trailing comment removed. */
function inlineValue(rest: string): string {
  let v = rest.trim()
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0]!
    const close = v.indexOf(q, 1)
    return close > 0 ? v.slice(0, close + 1) : v
  }
  const hash = v.search(/\s#/)
  if (hash >= 0) v = v.slice(0, hash)
  return v.trim()
}

const unquote = (v: string) =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v

/** Scalar at `path` (e.g. settings.android.versionName), unquoted; undefined when absent. */
export function getYamlScalar(text: string, path: string[]): string | undefined {
  const lines = text.split('\n')
  let start = 0
  let end = lines.length
  let indent = 0
  for (let p = 0; p < path.length; p++) {
    const i = findKey(lines, start, end, indent, path[p]!)
    if (i < 0) return undefined
    const rest = inlineValue(keyRe(path[p]!).exec(lines[i]!)![2]!)
    if (p === path.length - 1) return rest === '' ? undefined : unquote(rest)
    if (rest !== '') return undefined
    const blockStop = blockEnd(lines, i, indent, end)
    start = i + 1
    indent = childIndent(lines, start, blockStop, indent + 2)
    end = blockStop
  }
  return undefined
}

/**
 * Set `path` to `value` (a scalar, or a mapping of scalars written as a block), creating parent
 * mappings as needed. A key already present is replaced along with its whole block.
 * `file` names the file in errors.
 */
export function setYaml(text: string, path: string[], value: YamlValue, file = 'module.yaml'): string {
  const lines = text.split('\n')
  let start = 0
  let end = lines.length
  let indent = 0
  for (let p = 0; p < path.length - 1; p++) {
    const key = path[p]!
    let i = findKey(lines, start, end, indent, key)
    if (i < 0) {
      const at = insertAt(lines, start, end)
      lines.splice(at, 0, `${' '.repeat(indent)}${key}:`)
      i = at
      end++
    } else {
      const rest = inlineValue(keyRe(key).exec(lines[i]!)![2]!)
      if (rest !== '') {
        throw new KitError(
          `${file}: ${path.slice(0, p + 1).join('.')} is written inline (\`${key}: ${rest}\`)`,
          `Write it as a block mapping so kit can set ${path.join('.')}`,
          ExitCode.config,
        )
      }
    }
    const blockStop = blockEnd(lines, i, indent, end)
    start = i + 1
    indent = childIndent(lines, start, blockStop, indent + 2)
    end = blockStop
  }
  const key = path[path.length - 1]!
  const pad = ' '.repeat(indent)
  const childPad = ' '.repeat(indent + 2)
  const replacement =
    typeof value === 'string'
      ? [`${pad}${key}: ${value}`]
      : [`${pad}${key}:`, ...Object.entries(value).map(([k, v]) => `${childPad}${k}: ${v}`)]
  const i = findKey(lines, start, end, indent, key)
  // Replace through the block's last content line: trailing blank lines and comments stay.
  if (i >= 0) lines.splice(i, insertAt(lines, i, blockEnd(lines, i, indent, end)) - i, ...replacement)
  else lines.splice(insertAt(lines, start, end), 0, ...replacement)
  return lines.join('\n')
}

/** A YAML double-quoted scalar. */
export const yamlString = (s: string) => JSON.stringify(s)

export const ANDROID_VERSION_NAME = ['settings', 'android', 'versionName']
export const ANDROID_VERSION_CODE = ['settings', 'android', 'versionCode']
export const ANDROID_SIGNING = ['settings', 'android', 'signing']

export interface ReleaseEdit {
  version: string
  code: number
  /** Absolute path of the keystore.properties kit wrote; omitted leaves signing as the module has it. */
  signingProperties?: string
}

/** The app module's module.yaml with the release values written in. */
export function releaseModuleYaml(text: string, edit: ReleaseEdit, file = 'module.yaml'): string {
  let out = setYaml(text, ANDROID_VERSION_NAME, yamlString(edit.version), file)
  out = setYaml(out, ANDROID_VERSION_CODE, String(edit.code), file)
  if (edit.signingProperties) {
    out = setYaml(
      out,
      ANDROID_SIGNING,
      { enabled: 'true', propertiesFile: yamlString(edit.signingProperties) },
      file,
    )
  }
  return out
}

/**
 * keystore.properties for `settings.android.signing.propertiesFile`. Paths are absolute: the
 * toolchain resolves a relative storeFile from the module dir. The key password is the store
 * password (kit's convention, as in the Gradle `kit.release` plugin).
 */
export function keystoreProperties(storeFile: string, alias: string, password: string): string {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
  return [
    `storeFile=${esc(storeFile)}`,
    `storePassword=${esc(password)}`,
    `keyAlias=${esc(alias)}`,
    `keyPassword=${esc(password)}`,
    '',
  ].join('\n')
}

// ---- artifacts --------------------------------------------------------------------------------

/** An `.aab` path printed by `kotlin package`, resolved against `cwd`. */
export function aabFromOutput(output: string, cwd: string): string | undefined {
  const found = [...output.matchAll(/(\S+\.aab)\b/g)].map((m) => m[1]!.replace(/^['"`(]+|['"`).,:]+$/g, ''))
  for (const p of found.reverse()) {
    const abs = isAbsolute(p) ? p : resolve(cwd, p)
    if (existsSync(abs)) return abs
  }
  return undefined
}

/**
 * Newest `.aab` under `<toolchain root>/build/tasks/_<module>_*`, written at or after `since`
 * (ms). The fallback when the output names no path: the toolchain calls this layout temporary.
 */
export function findAab(toolchainDir: string, module: string, since = 0): string | undefined {
  const tasks = join(toolchainDir, 'build', 'tasks')
  if (!existsSync(tasks)) return undefined
  const prefix = `_${moduleName(module).replaceAll('/', '_')}_`
  const hits: { path: string; mtime: number }[] = []
  for (const d of readdirSync(tasks)) {
    if (!d.startsWith(prefix)) continue
    const dir = join(tasks, d)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.aab')) continue
      const path = join(dir, f)
      const mtime = statSync(path).mtimeMs
      if (mtime >= since) hits.push({ path, mtime })
    }
  }
  return hits.sort((a, b) => b.mtime - a.mtime)[0]?.path
}

/** versionName in the app module's module.yaml, or undefined when it doesn't set one. */
export function moduleVersionName(root: string, config: KitConfig, module: string): string | undefined {
  const path = join(root, moduleYamlPath(config, module))
  if (!existsSync(path)) {
    throw new KitError(
      `${moduleYamlPath(config, module)} not found`,
      'release.android.module names the app module (its dir under toolchain.root)',
      ExitCode.config,
    )
  }
  return getYamlScalar(readFileSync(path, 'utf8'), ANDROID_VERSION_NAME)
}
