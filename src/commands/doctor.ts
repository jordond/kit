import { defineCommand } from '../cli/command'
import type { KitConfig } from '../config/schema'
import type { Fix, FixResult } from '../lib/fix'
import { wrapperVersion } from '../lib/toolchain'

/**
 * `kit doctor`: one line per check on stderr (✔ ok, ▲ warning, ✖ failure), `--json` on stdout.
 * Each check is a pure function over what the run probed, so the rules are unit-tested without the
 * tools. A tool the project needs (java for a Gradle root, Xcode for an iOS release, …) fails; one
 * it doesn't need only warns. Any failure exits 4.
 *
 * `--fix` applies the repairs some checks carry (src/lib/fix.ts) after one confirmation, runs those
 * checks again, and reports the state after the fixes.
 */

export type Status = 'ok' | 'warn' | 'fail' | 'skip'

export interface Check {
  id: string
  label: string
  status: Status
  detail?: string
  hint?: string
  /** A safe, local repair `kit doctor --fix` can apply. */
  fix?: Fix
}

/** Output of a probed command; undefined when the binary is not on PATH. */
export type Probe = { code: number; output: string } | undefined

export const MIN_JAVA = 21

const missing = (id: string, label: string, required: boolean, hint: string): Check => ({
  id,
  label,
  status: required ? 'fail' : 'warn',
  detail: 'not found',
  hint,
})

export function checkBun(version: string): Check {
  return { id: 'bun', label: 'bun', status: 'ok', detail: version }
}

/** `java -version` → '21.0.2' (and '1.8.0_292' → '8'). */
export function parseJavaVersion(output: string): string | undefined {
  const m = output.match(/version "([^"]+)"/) ?? output.match(/\b(?:openjdk|java) (\d[\w.+-]*)/)
  if (!m) return undefined
  const v = m[1]!
  return v.startsWith('1.') ? (v.split('.')[1] ?? v) : v
}

export function checkJava(probe: Probe, required: boolean): Check {
  const hint = `Install JDK ${MIN_JAVA}+ (e.g. \`mise use java@${MIN_JAVA}\` or \`brew install --cask temurin\`)`
  // A non-zero exit is no JDK: macOS ships a /usr/bin/java stub that only says "Unable to locate a Java Runtime".
  if (probe?.code !== 0) return missing('java', 'java', required, hint)
  const version = parseJavaVersion(probe.output)
  const major = Number(version?.split(/[.+-]/)[0])
  if (!version || Number.isNaN(major)) {
    return { id: 'java', label: 'java', status: required ? 'fail' : 'warn', detail: 'unknown version', hint }
  }
  if (major < MIN_JAVA) {
    return {
      id: 'java',
      label: 'java',
      status: required ? 'fail' : 'warn',
      detail: `${version} (need ${MIN_JAVA}+)`,
      hint,
    }
  }
  return { id: 'java', label: 'java', status: 'ok', detail: version }
}

export function checkRuby(probe: Probe, required: boolean): Check {
  if (probe?.code !== 0) {
    return missing('ruby', 'ruby', required, 'Install Ruby for fastlane (e.g. `mise use ruby@3`)')
  }
  return { id: 'ruby', label: 'ruby', status: 'ok', detail: probe.output.match(/ruby (\S+)/)?.[1] ?? 'found' }
}

export function checkXcode(probe: Probe, required: boolean, platform: string): Check {
  if (platform !== 'darwin') return { id: 'xcode', label: 'Xcode', status: 'skip', detail: 'macOS only' }
  if (probe?.code !== 0) {
    return missing('xcode', 'Xcode', required, 'Install Xcode from the App Store, then `xcode-select -s`')
  }
  return {
    id: 'xcode',
    label: 'Xcode',
    status: 'ok',
    detail: probe.output.match(/Xcode (\S+)/)?.[1] ?? 'found',
  }
}

/** ANDROID_HOME / ANDROID_SDK_ROOT, or `sdk.dir` in the Gradle root's local.properties (brewd init). */
export function checkAndroidSdk(
  env: Record<string, string | undefined>,
  localProperties: string | undefined,
  exists: (path: string) => boolean,
  required: boolean,
): Check {
  const hint = 'Set ANDROID_HOME, or sdk.dir=… in <gradle root>/local.properties'
  const fromProps = localProperties?.match(/^\s*sdk\.dir\s*=\s*(.+?)\s*$/m)?.[1]
  const dir = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || fromProps
  if (!dir) return missing('android-sdk', 'Android SDK', required, hint)
  if (!exists(dir)) {
    return {
      id: 'android-sdk',
      label: 'Android SDK',
      status: required ? 'fail' : 'warn',
      detail: `${dir} missing`,
      hint,
    }
  }
  return { id: 'android-sdk', label: 'Android SDK', status: 'ok', detail: dir }
}

/** `wrangler whoami`; undefined when the repo has no worker target. */
export function checkWranglerLogin(
  probe: Probe | 'skip',
  install: { cmd: string[]; cwd?: string } = { cmd: ['bun', 'install'] },
): Check {
  const label = 'wrangler login'
  if (probe === 'skip') return { id: 'wrangler', label, status: 'skip', detail: 'no worker target' }
  const hint = 'Run `kit wrangler <target> login`, or set CLOUDFLARE_API_TOKEN'
  if (!probe)
    return {
      id: 'wrangler',
      label,
      status: 'warn',
      detail: 'wrangler not installed',
      hint: `Run \`${install.cmd.join(' ')}\``,
      fix: { description: install.cmd.join(' '), action: install },
    }
  if (probe.code !== 0 || /not authenticated|not logged in/i.test(probe.output)) {
    return { id: 'wrangler', label, status: 'warn', detail: 'not logged in', hint }
  }
  const who = probe.output.match(/associated with the email (\S+?)\.?\s/)?.[1]
  return { id: 'wrangler', label, status: 'ok', detail: who ?? 'logged in' }
}

/** `[tools]` of mise.toml → tool → version spec (`"21"`, `["21", "17"]`, `{ version = "21" }`). */
export function parseMiseTools(tools: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!tools || typeof tools !== 'object') return out
  for (const [name, spec] of Object.entries(tools as Record<string, unknown>)) {
    const first = Array.isArray(spec) ? spec[0] : spec
    const v = first && typeof first === 'object' ? (first as { version?: unknown }).version : first
    if (typeof v === 'string' || typeof v === 'number') out[name.replace(/^core:/, '')] = String(v)
  }
  return out
}

/** `"21"` matches `21.0.2`; `"temurin-21"` too; `latest`/`lts` always match. */
export function versionMatches(spec: string, actual: string): boolean {
  const want = spec.match(/\d+(?:\.\d+)*/)?.[0]
  if (!want) return true
  const a = actual.split(/[.+_-]/)
  return want.split('.').every((p, i) => a[i] === p)
}

export function checkMise(
  tools: Record<string, string> | undefined,
  detected: Record<string, string | undefined>,
  installed = true,
): Check {
  const label = 'mise.toml versions'
  if (!tools) return { id: 'mise', label, status: 'skip', detail: 'no mise.toml' }
  if (!installed) {
    return {
      id: 'mise',
      label,
      status: 'warn',
      detail: 'mise not installed',
      hint: 'Install mise (`brew install mise`), then `mise install` for the pinned tool versions',
    }
  }
  const drift: string[] = []
  for (const [tool, spec] of Object.entries(tools)) {
    if (!(tool in detected)) continue
    const actual = detected[tool]
    if (!actual) drift.push(`${tool} ${spec} (not found)`)
    else if (!versionMatches(spec, actual)) drift.push(`${tool} ${spec} (have ${actual})`)
  }
  if (drift.length)
    return {
      id: 'mise',
      label,
      status: 'warn',
      detail: drift.join(', '),
      hint: 'Run `mise install`',
      // The tools it installs are what java, ruby and ktlint probe.
      fix: {
        description: 'mise install',
        action: { cmd: ['mise', 'install'] },
        rechecks: ['java', 'ruby', 'ktlint'],
      },
    }
  return { id: 'mise', label, status: 'ok', detail: Object.keys(tools).join(', ') }
}

/** ktlint, which `kotlin` targets lint and format with; required when one uses the default. */
export function checkKtlint(probe: Probe, required: boolean): Check {
  const hint = 'Install ktlint (`mise install` with ktlint in mise.toml, or `brew install ktlint`)'
  if (probe?.code !== 0) return missing('ktlint', 'ktlint', required, hint)
  return { id: 'ktlint', label: 'ktlint', status: 'ok', detail: parseKtlintVersion(probe.output) ?? 'found' }
}

/** `ktlint --version` → '1.8.0'. */
export function parseKtlintVersion(output: string): string | undefined {
  return output.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1]
}

export const LEFTHOOK_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml']

/**
 * A repo with a lefthook config: lefthook on PATH and its pre-commit hook installed in this clone.
 * `hook` is the text of git's pre-commit hook (undefined: none). Warnings only; skipped in CI,
 * where nothing commits.
 */
export function checkLefthook(
  file: string | undefined,
  installed: boolean,
  hook: string | undefined,
  ci: boolean,
): Check {
  const label = 'lefthook'
  if (!file) return { id: 'lefthook', label, status: 'skip', detail: 'no lefthook.yml' }
  if (ci) return { id: 'lefthook', label, status: 'skip', detail: 'CI' }
  if (!installed) {
    return {
      id: 'lefthook',
      label,
      status: 'warn',
      detail: 'lefthook not installed',
      hint: 'Install it (`brew install lefthook`), then run `lefthook install`',
    }
  }
  if (!hook || !/lefthook/.test(hook)) {
    return {
      id: 'lefthook',
      label,
      status: 'warn',
      detail: `${file} hooks not installed in this clone`,
      hint: 'Run `lefthook install`',
      fix: { description: 'lefthook install', action: { cmd: ['lefthook', 'install'] } },
    }
  }
  return { id: 'lefthook', label, status: 'ok', detail: 'pre-commit hook installed' }
}

/** A project file kit reads (mise.toml, package.json) that does not parse: a failure, not a crash. */
export function checkUnreadable(id: string, label: string, file: string, error: unknown): Check {
  const why = error instanceof Error ? error.message.split('\n')[0] : String(error)
  return { id, label, status: 'fail', detail: `${file} does not parse: ${why}`, hint: `Fix ${file}` }
}

/** Key names in a dotenv file. */
export function parseEnvKeys(text: string): string[] {
  const keys: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m) keys.push(m[1]!)
  }
  return keys
}

/** `.env` has every key `.env.example` names (names only; values are never read into the result). */
export function checkEnvFile(example: string | undefined, env: string | undefined): Check {
  const label = '.env'
  if (example === undefined) return { id: 'env', label, status: 'skip', detail: 'no .env.example' }
  if (env === undefined)
    return { id: 'env', label, status: 'fail', detail: 'missing', hint: 'Run `kit init`' }
  const have = new Set(parseEnvKeys(env))
  const absent = parseEnvKeys(example).filter((k) => !have.has(k))
  if (absent.length) {
    return {
      id: 'env',
      label,
      status: 'warn',
      detail: `missing ${absent.join(', ')}`,
      hint: 'Add them to .env',
    }
  }
  return { id: 'env', label, status: 'ok', detail: 'complete' }
}

const KIT_USES = /jordond\/kit\/[^@\s]+@\S+\s*#\s*v?(\d+\.\d+\.\d+\S*)/g

/**
 * TOML `app-ios-version` == `release.ios.xcconfig` MARKETING_VERSION (what local Xcode builds show).
 * `drift` is version.ts's iosVersionDrift, passed in so doctor loads it only when needed.
 */
export function checkIosVersion(
  drift: () => { toml: string; xcconfig: string | undefined; file: string } | undefined,
  fix?: (drift: { toml: string; file: string }) => Fix,
): Check {
  const label = 'iOS version'
  try {
    const d = drift()
    if (!d) return { id: 'ios-version', label, status: 'ok', detail: 'TOML and xcconfig agree' }
    return {
      id: 'ios-version',
      label,
      status: 'fail',
      detail: `TOML ${d.toml}, ${d.file} ${d.xcconfig ?? '(no MARKETING_VERSION)'}`,
      hint: `Set MARKETING_VERSION = ${d.toml} in ${d.file}`,
      // Without the line there is nothing to rewrite: adding it stays a manual edit.
      ...(fix && d.xcconfig !== undefined ? { fix: fix(d) } : {}),
    }
  } catch (e) {
    return { id: 'ios-version', label, status: 'fail', detail: e instanceof Error ? e.message : String(e) }
  }
}

export function checkAndroidVersion(
  drift: () => { toml: string; module: string; file: string } | undefined,
  fix?: (drift: { toml: string; file: string }) => Fix,
): Check {
  const label = 'Android version'
  try {
    const d = drift()
    if (!d) return { id: 'android-version', label, status: 'ok', detail: 'TOML and module.yaml agree' }
    return {
      id: 'android-version',
      label,
      status: 'fail',
      detail: `TOML ${d.toml}, ${d.file} ${d.module}`,
      hint: `Set settings.android.versionName: "${d.toml}" in ${d.file}`,
      ...(fix ? { fix: fix(d) } : {}),
    }
  } catch (e) {
    return {
      id: 'android-version',
      label,
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * The Kotlin toolchain wrapper in toolchain.root and its pinned version. `wrapper` is the
 * script's text (undefined: missing); `executable` whether it can run.
 */
export function checkToolchain(
  root: string | undefined,
  wrapper: string | undefined,
  executable: boolean,
): Check {
  const label = 'kotlin toolchain'
  if (root === undefined) return { id: 'toolchain', label, status: 'skip', detail: 'no toolchain root' }
  const path = `${root.replace(/\/+$/, '')}/kotlin`
  if (wrapper === undefined) {
    return {
      id: 'toolchain',
      label,
      status: 'fail',
      detail: `${path} missing`,
      hint: 'Check toolchain.root in kit.config.ts, or run `kotlin init` there',
    }
  }
  if (!executable) {
    return {
      id: 'toolchain',
      label,
      status: 'fail',
      detail: `${path} not executable`,
      hint: `chmod +x ${path}`,
      fix: { description: `chmod +x ${path}`, action: { cmd: ['chmod', '+x', path] } },
    }
  }
  const version = wrapperVersion(wrapper)
  if (!version) {
    return {
      id: 'toolchain',
      label,
      status: 'warn',
      detail: `${path}: no kotlin_cli_version`,
      hint: 'Pin the toolchain version in the wrapper (`./kotlin update` writes it)',
    }
  }
  return { id: 'toolchain', label, status: 'ok', detail: version }
}

/**
 * Release secrets for the configured platforms (PLAN §9.5), by name only. Missing ones only warn,
 * on GitHub Actions too: most jobs (lint, PRs, forks, the other platform) get no signing secrets,
 * and `kit release` itself stops on a missing one. The CI-only names are checked on Actions.
 */
export function checkReleaseSecrets(
  secrets: { required: string[]; ci: string[]; optional: string[] },
  env: Record<string, string | undefined>,
  onActions: boolean,
  renameHints: (missing: string[]) => string[] = () => [],
): Check {
  const label = 'release secrets'
  const wanted = [...secrets.required, ...(onActions ? secrets.ci : [])]
  if (!wanted.length) return { id: 'release-secrets', label, status: 'skip', detail: 'no release configured' }
  const set = (n: string) => !!env[n]?.trim()
  const missing = wanted.filter((n) => !set(n))
  const optional = secrets.optional.filter((n) => !set(n))
  if (missing.length) {
    const renames = renameHints(missing)
    return {
      id: 'release-secrets',
      label,
      status: 'warn',
      detail: `missing ${missing.join(', ')}`,
      hint: renames.length
        ? `Rename in .env: ${renames.join(', ')}`
        : onActions
          ? 'Pass them to the job as secrets'
          : 'Add them to .env to release from this machine',
    }
  }
  return {
    id: 'release-secrets',
    label,
    status: optional.length ? 'warn' : 'ok',
    detail: optional.length ? `all set; optional ${optional.join(', ')} unset` : `${wanted.length} set`,
    ...(optional.length ? { hint: 'Without SENTRY_AUTH_TOKEN the dSYM upload is skipped' } : {}),
  }
}

/**
 * Workflow `uses: jordond/kit/…@<sha> # vX.Y.Z` pins vs the package.json pin. The SHA itself isn't
 * resolved (stub): the version comment Renovate keeps next to it is compared instead.
 */
export function checkCiPin(
  workflows: { file: string; text: string }[],
  pin: string | undefined,
  strict: boolean,
  fix?: (version: string) => Fix | undefined,
): Check {
  const label = 'CI kit pin'
  const found = workflows.flatMap(({ file, text }) =>
    [...text.matchAll(KIT_USES)].map((m) => ({ file, v: m[1]! })),
  )
  if (!found.length || !pin) return { id: 'ci-pin', label, status: 'skip', detail: 'no pinned kit workflow' }
  const want = pin.replace(/^[\^~=v]+/, '')
  const off = found.filter((f) => f.v !== want)
  if (off.length) {
    const repin = fix?.(want)
    return {
      id: 'ci-pin',
      label,
      status: strict ? 'fail' : 'warn',
      detail: `${off.map((f) => `${f.file} v${f.v}`).join(', ')} ≠ package.json ${want}`,
      hint: 'Run `kit upgrade <version>`: it moves the npm pin and the workflow SHAs together',
      ...(repin ? { fix: repin } : {}),
    }
  }
  return { id: 'ci-pin', label, status: 'ok', detail: want }
}

/** `[versions]` keys kit's Gradle plugins read from the `libs` catalog (PLAN §13.5): a contract. */
export const CATALOG_KEYS = [
  // namespace and BuildInfo package default
  'app-name',
  'app-android-sdk-compile',
  'app-android-sdk-target',
  'app-android-sdk-min',
  'app-jvm-target',
  'app-android-version',
  'app-ios-version',
] as const

/** The catalog's path, repo-relative: `versions.file`, else `<gradle root>/gradle/libs.versions.toml`. */
export function catalogPath(config: KitConfig | undefined): string | undefined {
  if (!config?.gradle) return undefined
  return config.versions?.file ?? `${config.gradle.root.replace(/\/+$/, '')}/gradle/libs.versions.toml`
}

/** Every key in CATALOG_KEYS under `[versions]`; `catalog` is the parsed TOML (undefined: no file). */
export function checkCatalogKeys(
  file: string | undefined,
  catalog: Record<string, unknown> | undefined,
): Check {
  const label = 'catalog keys'
  if (!file) return { id: 'catalog', label, status: 'skip', detail: 'no gradle root' }
  if (!catalog) {
    return {
      id: 'catalog',
      label,
      status: 'fail',
      detail: `${file} missing`,
      hint: `Create it with [versions] ${CATALOG_KEYS.join(', ')}`,
    }
  }
  const versions = catalog.versions
  const have = versions && typeof versions === 'object' ? (versions as Record<string, unknown>) : {}
  const absent = CATALOG_KEYS.filter((k) => have[k] === undefined)
  if (absent.length) {
    return {
      id: 'catalog',
      label,
      status: 'fail',
      detail: `${file} [versions] missing ${absent.join(', ')}`,
      hint: `Add them under [versions] in ${file}; kit's Gradle plugins read them`,
    }
  }
  return { id: 'catalog', label, status: 'ok', detail: file }
}

export default defineCommand({
  description: 'Check tools, versions and .env',
  group: 'Setup',
  args: {
    ci: { type: 'boolean', description: 'Fail when CI workflow pins drift from the package.json pin' },
    fix: { type: 'boolean', description: 'Apply the safe, local fixes, then check again' },
  },
  examples: 'kit doctor\nkit doctor --json\nkit doctor --ci\nkit doctor --fix\nkit doctor --fix --dry-run',
  async run(ctx) {
    const { accessSync, constants, existsSync, readdirSync, readFileSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const pc = (await import('picocolors')).default
    const { emitJson } = await import('../lib/log')
    const { runQuiet } = await import('../lib/proc')
    const { detectPackageManager, pmExec } = await import('../lib/pm')
    const { parseToml, readToml } = await import('../lib/toml')
    const { ExitCode } = await import('../lib/errors')
    const { installDir } = await import('../config/load')
    const { androidVersionFix, applyFix, ciPinFix, describeFix, fixable, iosVersionFix, pinVersion } =
      await import('../lib/fix')

    const { onGitHubActions, releaseSecrets, renameHints } = await import('../lib/release/creds')
    const { androidVersionDrift, iosVersionDrift } = await import('../lib/release/version')
    const root = ctx.root ?? process.cwd()
    const config = ctx.config
    const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined)

    // Probes run once per pass and are shared between checks; a fix clears them before the re-check.
    let probes = new Map<string, Promise<unknown>>()
    const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      if (!probes.has(key)) probes.set(key, fn())
      return probes.get(key) as Promise<T>
    }
    const probe = (cmd: string[]): Promise<Probe> =>
      once(cmd.join(' '), async () => (Bun.which(cmd[0]!) ? await runQuiet(cmd, { cwd: root }) : undefined))

    const targets = Object.values(config?.targets ?? {})
    // The Kotlin toolchain provisions its own JDK and Android SDK: neither is required for it.
    const gradle = !!config?.gradle || targets.some((t) => t.kind === 'gradle')
    const toolchainRoot = config?.toolchain?.root
    const wrapperPath = toolchainRoot === undefined ? undefined : join(root, toolchainRoot, 'kotlin')
    const ios = !!config?.release?.ios
    const fastlane = ios || !!config?.release?.android
    const worker = targets.find((t) => t.kind === 'worker')
    // kotlin targets lint and format with ktlint unless both verbs are overridden or off.
    const ktlintUsed = targets.some(
      (t) => t.kind === 'kotlin' && (t.lint === undefined || t.format === undefined),
    )
    const lefthookFile = LEFTHOOK_FILES.find((f) => existsSync(join(root, f)))
    const miseFile = ['mise.toml', '.mise.toml'].find((f) => existsSync(join(root, f)))
    // The kit pin: `.kit/package.json` when the repo installs kit there, else the root package.json.
    const pkgFile = installDir(root) === '.' ? 'package.json' : `${installDir(root)}/package.json`
    const catalogFile = catalogPath(config)

    const java = () => probe(['java', '-version'])
    const ruby = () => probe(['ruby', '--version'])
    const ktlint = async () => (ktlintUsed ? await probe(['ktlint', '--version']) : undefined)
    const wrangler = async (): Promise<Probe | 'skip'> => {
      if (!worker) return 'skip'
      const dir = join(root, worker.dir)
      // Never let `bun x` download wrangler just to ask who is logged in.
      const bin = 'node_modules/.bin/wrangler'
      if (!existsSync(join(dir, bin)) && !existsSync(join(root, bin))) return undefined
      return await runQuiet(pmExec(detectPackageManager(dir, root), 'wrangler', 'whoami'), {
        cwd: dir,
      }).catch(() => undefined)
    }
    /** `<pm> install` where the worker's dependencies come from: the root workspace, else its own dir. */
    const install = () => {
      const dir = worker && !existsSync(join(root, 'package.json')) ? worker.dir : '.'
      return { cmd: [detectPackageManager(join(root, dir), root), 'install'], cwd: dir }
    }
    const mise = async (): Promise<Check> => {
      if (!miseFile) return checkMise(undefined, {})
      let tools: Record<string, string>
      try {
        tools = parseMiseTools(readToml(join(root, miseFile)).tools)
      } catch (e) {
        return checkUnreadable('mise', 'mise.toml versions', miseFile, e)
      }
      const [j, r] = await Promise.all([java(), ruby()])
      const detected: Record<string, string | undefined> = {
        bun: Bun.version,
        java: j?.code === 0 ? parseJavaVersion(j.output) : undefined,
        ruby: r?.output.match(/ruby (\d[\w.]*)/)?.[1],
      }
      if (tools.ktlint) {
        const k = await ktlint()
        detected.ktlint = k?.code === 0 ? parseKtlintVersion(k.output) : undefined
      }
      if (tools.node) detected.node = (await probe(['node', '--version']))?.output.trim().replace(/^v/, '')
      return checkMise(tools, detected, !!Bun.which('mise'))
    }
    const lefthook = async (): Promise<Check> => {
      let hook: string | undefined
      if (lefthookFile) {
        // --git-path follows worktrees and core.hooksPath.
        const r = await probe(['git', 'rev-parse', '--git-path', 'hooks/pre-commit'])
        const hookPath = r?.code === 0 ? resolve(root, r.output.trim()) : undefined
        if (hookPath && existsSync(hookPath)) hook = readFileSync(hookPath, 'utf8')
      }
      return checkLefthook(lefthookFile, !!Bun.which('lefthook'), hook, onGitHubActions())
    }
    const toolchain = (): Check => {
      const wrapper = wrapperPath && existsSync(wrapperPath) ? readFileSync(wrapperPath, 'utf8') : undefined
      let executable = false
      if (wrapperPath && wrapper !== undefined) {
        try {
          accessSync(wrapperPath, constants.X_OK)
          executable = true
        } catch {}
      }
      return checkToolchain(toolchainRoot, wrapper, executable)
    }
    const kitPin = (): { pin?: string; unreadable?: Check } => {
      const text = read(pkgFile)
      try {
        const pkg = (text ? JSON.parse(text) : {}) as {
          devDependencies?: Record<string, string>
          dependencies?: Record<string, string>
        }
        return { pin: pkg.devDependencies?.['@jordond/kit'] ?? pkg.dependencies?.['@jordond/kit'] }
      } catch (e) {
        return { unreadable: checkUnreadable('package-json', 'package.json', pkgFile, e) }
      }
    }
    const ciPin = (): Check => {
      const wfDir = join(root, '.github/workflows')
      const workflows = existsSync(wfDir)
        ? readdirSync(wfDir)
            .filter((f) => /\.ya?ml$/.test(f))
            .map((f) => ({ file: f, text: readFileSync(join(wfDir, f), 'utf8') }))
        : []
      const { pin } = kitPin()
      const version = pinVersion(pin)
      return checkCiPin(workflows, pin, ctx.args.ci === true, () =>
        version ? ciPinFix(root, version) : undefined,
      )
    }
    const catalog = (): Check => {
      try {
        const text = catalogFile ? read(catalogFile) : undefined
        return checkCatalogKeys(catalogFile, text === undefined ? undefined : parseToml(text))
      } catch (e) {
        return checkUnreadable('catalog', 'catalog keys', catalogFile ?? '', e)
      }
    }

    // One entry per check, in report order; `run` returns undefined for a check that does not apply.
    type Entry = { id: string; run: () => Check | undefined | Promise<Check | undefined> }
    const entries: Entry[] = [
      { id: 'bun', run: () => checkBun(Bun.version) },
      { id: 'java', run: async () => checkJava(await java(), gradle) },
      { id: 'ruby', run: async () => checkRuby(await ruby(), fastlane) },
      {
        id: 'xcode',
        run: async () =>
          checkXcode(
            process.platform === 'darwin' ? await probe(['xcodebuild', '-version']) : undefined,
            ios,
            process.platform,
          ),
      },
      {
        id: 'android-sdk',
        run: () =>
          checkAndroidSdk(
            process.env,
            config?.gradle ? read(join(config.gradle.root, 'local.properties')) : undefined,
            existsSync,
            gradle,
          ),
      },
      { id: 'toolchain', run: () => (toolchainRoot !== undefined ? toolchain() : undefined) },
      { id: 'wrangler', run: async () => checkWranglerLogin(await wrangler(), install()) },
      { id: 'ktlint', run: async () => (ktlintUsed ? checkKtlint(await ktlint(), true) : undefined) },
      { id: 'mise', run: mise },
      { id: 'lefthook', run: lefthook },
      { id: 'env', run: () => checkEnvFile(read('.env.example'), read('.env')) },
      {
        id: 'ios-version',
        run: () =>
          config?.release?.ios?.xcconfig
            ? checkIosVersion(
                () => iosVersionDrift(root, config),
                (d) => iosVersionFix(root, d),
              )
            : undefined,
      },
      {
        id: 'android-version',
        run: () =>
          config?.toolchain && config.release?.android
            ? checkAndroidVersion(
                () => androidVersionDrift(root, config),
                (d) => androidVersionFix(root, d),
              )
            : undefined,
      },
      {
        id: 'release-secrets',
        run: () =>
          checkReleaseSecrets(releaseSecrets(config), process.env, onGitHubActions(), (m) =>
            renameHints(m, (old) => !!process.env[old]),
          ),
      },
      { id: 'ci-pin', run: ciPin },
      { id: 'catalog', run: catalog },
      { id: 'package-json', run: () => kitPin().unreadable },
    ]
    const found = await Promise.all(entries.map((e) => e.run()))
    const current = () => found.filter((c): c is Check => c !== undefined)

    // ---- --fix ---------------------------------------------------------------------------------
    const say = !ctx.flags.json
    const wantFix = ctx.args.fix === true
    const fixes: FixResult[] = []
    const todo = wantFix ? fixable(current()) : []
    if (todo.length) {
      if (say) {
        ctx.log.info(`${todo.length} fixable:`)
        for (const c of todo) ctx.log.step(`${c.label}  ${pc.dim(c.fix.description)}`)
      }
      let refused: string | undefined
      if (ctx.flags.dryRun) refused = 'dry run'
      else if (!ctx.flags.yes && !ctx.flags.interactive) refused = 'no terminal; re-run with --yes'
      else {
        const { confirm } = await import('../lib/prompt')
        const n = todo.length
        if (!(await confirm(ctx.flags, `Apply ${n} fix${n === 1 ? '' : 'es'}?`, { initial: true }))) {
          refused = 'declined'
        }
      }
      if (refused !== undefined) {
        for (const c of todo) {
          fixes.push({
            id: c.id,
            description: c.fix.description,
            applied: false,
            ok: ctx.flags.dryRun,
            ...(ctx.flags.dryRun ? {} : { error: refused }),
          })
        }
        if (say) ctx.log.warn(`Nothing fixed (${refused})`)
      } else {
        const again = new Set<string>()
        for (const c of todo) {
          const r = await applyFix(root, c.id, c.fix)
          fixes.push(r)
          if (say) {
            if (r.ok) ctx.log.success(`fixed ${c.label}  ${pc.dim(r.description)}`)
            else if (r.applied) ctx.log.error(`${r.description} failed`, r.error)
            else ctx.log.warn(`skipped ${r.description}: ${r.error}`)
          }
          if (r.applied) for (const id of [c.id, ...(c.fix.rechecks ?? [])]) again.add(id)
        }
        // Only the checks a fix touched run again, on fresh probes.
        probes = new Map()
        await Promise.all(
          entries.map(async (e, i) => {
            if (again.has(e.id)) found[i] = await e.run()
          }),
        )
      }
      if (say) ctx.log.info('')
    }

    const checks = current()
    const ok = !checks.some((c) => c.status === 'fail')
    if (ctx.flags.json) {
      emitJson({
        ok,
        checks: checks.map((c) => (c.fix ? { ...c, fix: describeFix(c.fix) } : c)),
        ...(wantFix ? { fixes } : {}),
      })
    } else {
      const width = Math.max(...checks.map((c) => c.label.length)) + 2
      for (const c of checks) {
        const line = `${c.label.padEnd(width)}${pc.dim(c.detail ?? '')}`
        if (c.status === 'ok') ctx.log.success(line)
        else if (c.status === 'warn') {
          ctx.log.warn(line)
          if (c.hint) ctx.log.dim(`  › ${c.hint}`)
        } else if (c.status === 'fail') ctx.log.error(line, c.hint)
        else if (!ctx.flags.quiet) ctx.log.dim(`- ${line}`)
      }
      const left = fixable(checks).length
      if (left && !wantFix) ctx.log.dim(`${left} fixable with \`kit doctor --fix\``)
    }
    if (!ok) process.exitCode = ExitCode.precondition
  },
})
