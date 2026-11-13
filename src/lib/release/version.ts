import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import { getTomlValue, setTomlValue } from '../toml'
import { moduleYaml, releaseAndroidModule } from '../module'
import { ANDROID_VERSION_NAME, moduleVersionName, setYaml, yamlString } from '../toolchain'

/**
 * Version names live in the catalog TOML (`[versions]`), keyed by `versions.keys` (PLAN §9.2):
 * `{ ios: 'app-ios-version', android: 'app-android-version', api: 'api-server-version' }`.
 * Build numbers never do (policy B).
 */

export const bumpLevels = ['patch', 'minor', 'major'] as const
export type BumpLevel = (typeof bumpLevels)[number]

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const TABLE = 'versions'

export function nextVersion(current: string, level: BumpLevel): string {
  const m = SEMVER.exec(current)
  if (!m) throw new KitError(`"${current}" is not a MAJOR.MINOR.PATCH version`, undefined, ExitCode.config)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)?.slice(1).map(Number)
  const pb = SEMVER.exec(b)?.slice(1).map(Number)
  if (!pa || !pb) throw new Error(`Not MAJOR.MINOR.PATCH: "${pa ? b : a}"`)
  return pa.map((n, i) => n - pb[i]!).find((d) => d !== 0) ?? 0
}

export interface VersionFile {
  /** Repo-relative path. */
  file: string
  keys: Record<string, string>
}

export function versionFile(config: KitConfig): VersionFile {
  if (!config.versions) {
    throw new KitError(
      'No versions configured',
      "Set versions.file and versions.keys in kit.config.ts (e.g. keys: { ios: 'app-ios-version' })",
      ExitCode.config,
    )
  }
  return config.versions
}

/** The catalog key for a platform or service name, or a usage error listing the names. */
export function versionKey(config: KitConfig, name: string): string {
  const { keys } = versionFile(config)
  const key = keys[name]
  if (!key) {
    throw new KitError(
      `No version key for "${name}"`,
      `Known: ${Object.keys(keys).join(', ') || '(none)'}; add versions.keys.${name} in kit.config.ts`,
      ExitCode.usage,
    )
  }
  return key
}

/** Every configured name → its current version. */
export function readVersions(root: string, config: KitConfig): Record<string, string> {
  const { file, keys } = versionFile(config)
  const text = readFileSync(join(root, file), 'utf8')
  return Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, readKey(text, file, key)]))
}

export function readVersion(root: string, config: KitConfig, name: string): string {
  const { file } = versionFile(config)
  return readKey(readFileSync(join(root, file), 'utf8'), file, versionKey(config, name))
}

function readKey(text: string, file: string, key: string): string {
  const value = getTomlValue(text, TABLE, key)
  if (typeof value !== 'string' || !value) {
    throw new KitError(`${file}: [${TABLE}] ${key} is missing or not a string`, undefined, ExitCode.config)
  }
  return value
}

/** Rewrite `name`'s value in the TOML text, touching only that value. */
export function setVersion(text: string, config: KitConfig, name: string, to: string): string {
  return setTomlValue(text, TABLE, versionKey(config, name), to)
}

/** `all` = the mobile platforms that have keys; anything else must be a key name. */
export function expandPlatforms(config: KitConfig, platform: string): string[] {
  const { keys } = versionFile(config)
  if (platform === 'all') {
    const mobile = ['ios', 'android'].filter((p) => keys[p])
    if (!mobile.length) throw new KitError('No ios or android version keys', undefined, ExitCode.config)
    return mobile
  }
  versionKey(config, platform)
  return [platform]
}

// One unconditional `MARKETING_VERSION = x` line; `[ \t]` so an empty value can't reach the next line.
const MARKETING = /^([ \t]*MARKETING_VERSION[ \t]*=[ \t]*)([^\s/]+)(.*)$/gm

function marketingLines(text: string, file: string): RegExpExecArray[] {
  const found = [...text.matchAll(MARKETING)]
  if (found.length > 1) {
    throw new KitError(
      `${file} sets MARKETING_VERSION ${found.length} times`,
      'Keep one `MARKETING_VERSION = <version>` line (Xcode uses the last; kit edits only one)',
      ExitCode.config,
    )
  }
  return found
}

/** MARKETING_VERSION from xcconfig text, or undefined when the key isn't set there. */
export function xcconfigVersion(text: string, file = 'xcconfig'): string | undefined {
  return marketingLines(text, file)[0]?.[2]
}

/** Rewrite MARKETING_VERSION's value, keeping the rest of the line (comments, spacing). */
export function setXcconfigVersion(text: string, file: string, to: string): string {
  if (!marketingLines(text, file).length) {
    throw new KitError(
      `${file} has no MARKETING_VERSION line`,
      'Add `MARKETING_VERSION = <version>`',
      ExitCode.config,
    )
  }
  return text.replace(MARKETING, (_m, head: string, _v: string, tail: string) => `${head}${to}${tail}`)
}

/** `release.ios.xcconfig`'s text, or a config error naming the file. */
export function readXcconfig(root: string, file: string): string {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch (e) {
    throw new KitError(
      `Cannot read release.ios.xcconfig ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`,
      'Fix the path in kit.config.ts (repo-relative)',
      ExitCode.config,
    )
  }
}

/**
 * The iOS version must read the same in the TOML and in `release.ios.xcconfig`: local Xcode builds
 * use the xcconfig, releases the TOML (one binary reporting two versions splits analytics).
 * Returns the mismatch, or undefined when equal or no xcconfig is configured.
 */
export function iosVersionDrift(
  root: string,
  config: KitConfig,
): { toml: string; xcconfig: string | undefined; file: string } | undefined {
  const file = config.release?.ios?.xcconfig
  if (!file) return undefined
  if (!config.versions?.keys.ios) {
    throw new KitError(
      'release.ios.xcconfig is set but versions.keys.ios is not',
      "Add versions.keys.ios (e.g. 'app-ios-version') in kit.config.ts",
      ExitCode.config,
    )
  }
  const toml = readVersion(root, config, 'ios')
  const xc = xcconfigVersion(readXcconfig(root, file), file)
  return xc === toml ? undefined : { toml, xcconfig: xc, file }
}

/**
 * Kotlin toolchain: the Android version must read the same in the TOML and in the app module's
 * module.yaml (`settings.android.versionName`), which local `./kotlin run` builds use. Returns the
 * mismatch, or undefined when equal, when the module sets no versionName, or without a toolchain.
 */
export function androidVersionDrift(
  root: string,
  config: KitConfig,
): { toml: string; module: string; file: string } | undefined {
  if (!config.toolchain || !config.versions?.keys.android) return undefined
  const module = releaseAndroidModule(root, config, 'toolchain')
  if (!module) return undefined
  const yaml = moduleVersionName(root, config, module)
  if (yaml === undefined) return undefined
  const toml = readVersion(root, config, 'android')
  return yaml === toml ? undefined : { toml, module: yaml, file: moduleYaml(module) }
}

/** module.yaml text with `settings.android.versionName` set (added when missing). */
export function setModuleVersion(text: string, file: string, to: string): string {
  return setYaml(text, ANDROID_VERSION_NAME, yamlString(to), file)
}
