import { defineCommand } from '../cli/command'
import type { KitConfig } from '../config/schema'
import { wrapperVersion } from '../lib/toolchain'

/**
 * `kit doctor`: one line per check on stderr (✔ ok, ▲ warning, ✖ failure), `--json` on stdout.
 * Each check is a pure function over what the run probed, so the rules are unit-tested without the
 * tools. A tool the project needs (java for a Gradle root, Xcode for an iOS release, …) fails; one
 * it doesn't need only warns. Any failure exits 4.
 */

export type Status = 'ok' | 'warn' | 'fail' | 'skip'

export interface Check {
  id: string
  label: string
  status: Status
  detail?: string
  hint?: string
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
export function checkWranglerLogin(probe: Probe | 'skip'): Check {
  const label = 'wrangler login'
  if (probe === 'skip') return { id: 'wrangler', label, status: 'skip', detail: 'no worker target' }
  const hint = 'Run `kit wrangler <target> login`, or set CLOUDFLARE_API_TOKEN'
  if (!probe)
    return {
      id: 'wrangler',
      label,
      status: 'warn',
      detail: 'wrangler not installed',
      hint: 'Run `bun install`',
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
    return { id: 'mise', label, status: 'warn', detail: drift.join(', '), hint: 'Run `mise install`' }
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
    }
  } catch (e) {
    return { id: 'ios-version', label, status: 'fail', detail: e instanceof Error ? e.message : String(e) }
  }
}

export function checkAndroidVersion(
  drift: () => { toml: string; module: string; file: string } | undefined,
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
): Check {
  const label = 'CI kit pin'
  const found = workflows.flatMap(({ file, text }) =>
    [...text.matchAll(KIT_USES)].map((m) => ({ file, v: m[1]! })),
  )
  if (!found.length || !pin) return { id: 'ci-pin', label, status: 'skip', detail: 'no pinned kit workflow' }
  const want = pin.replace(/^[\^~=v]+/, '')
  const off = found.filter((f) => f.v !== want)
  if (off.length) {
    return {
      id: 'ci-pin',
      label,
      status: strict ? 'fail' : 'warn',
      detail: `${off.map((f) => `${f.file} v${f.v}`).join(', ')} ≠ package.json ${want}`,
      hint: 'Run `kit upgrade <version>`: it moves the npm pin and the workflow SHAs together',
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
  },
  examples: 'kit doctor\nkit doctor --json\nkit doctor --ci',
  async run(ctx) {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const pc = (await import('picocolors')).default
    const { emitJson } = await import('../lib/log')
    const { runQuiet } = await import('../lib/proc')
    const { detectPackageManager, pmExec } = await import('../lib/pm')
    const { parseToml, readToml } = await import('../lib/toml')
    const { ExitCode } = await import('../lib/errors')
    const { installDir } = await import('../config/load')

    const { onGitHubActions, releaseSecrets, renameHints } = await import('../lib/release/creds')
    const { androidVersionDrift, iosVersionDrift } = await import('../lib/release/version')
    const { accessSync, constants } = await import('node:fs')
    const root = ctx.root ?? process.cwd()
    const config = ctx.config
    const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined)
    const probe = async (cmd: string[], cwd = root): Promise<Probe> => {
      if (!Bun.which(cmd[0]!)) return undefined
      return await runQuiet(cmd, { cwd })
    }

    const targets = Object.values(config?.targets ?? {})
    // The Kotlin toolchain provisions its own JDK and Android SDK: neither is required for it.
    const gradle = !!config?.gradle || targets.some((t) => t.kind === 'gradle')
    const toolchainRoot = config?.toolchain?.root
    const wrapperPath = toolchainRoot === undefined ? undefined : join(root, toolchainRoot, 'kotlin')
    let wrapperExec = false
    if (wrapperPath && existsSync(wrapperPath)) {
      try {
        accessSync(wrapperPath, constants.X_OK)
        wrapperExec = true
      } catch {}
    }
    const ios = !!config?.release?.ios
    const fastlane = ios || !!config?.release?.android
    const worker = Object.values(config?.targets ?? {}).find((t) => t.kind === 'worker')

    // kotlin targets lint and format with ktlint unless both verbs are overridden or off.
    const ktlintUsed = targets.some(
      (t) => t.kind === 'kotlin' && (t.lint === undefined || t.format === undefined),
    )
    const ktlint = ktlintUsed ? await probe(['ktlint', '--version']) : undefined
    const lefthookFile = LEFTHOOK_FILES.find((f) => existsSync(join(root, f)))
    let lefthookHook: string | undefined
    if (lefthookFile) {
      // --git-path follows worktrees and core.hooksPath.
      const r = await probe(['git', 'rev-parse', '--git-path', 'hooks/pre-commit'])
      const hookPath = r?.code === 0 ? resolve(root, r.output.trim()) : undefined
      if (hookPath && existsSync(hookPath)) lefthookHook = readFileSync(hookPath, 'utf8')
    }

    const [java, ruby, xcode, wrangler] = await Promise.all([
      probe(['java', '-version']),
      probe(['ruby', '--version']),
      process.platform === 'darwin' ? probe(['xcodebuild', '-version']) : Promise.resolve(undefined),
      worker
        ? (async () => {
            const dir = join(root, worker.dir)
            // Never let `bun x` download wrangler just to ask who is logged in.
            const bin = 'node_modules/.bin/wrangler'
            if (!existsSync(join(dir, bin)) && !existsSync(join(root, bin))) return undefined
            return await runQuiet(pmExec(detectPackageManager(dir, root), 'wrangler', 'whoami'), {
              cwd: dir,
            }).catch(() => undefined)
          })()
        : Promise.resolve('skip' as const),
    ])

    const miseFile = ['mise.toml', '.mise.toml'].find((f) => existsSync(join(root, f)))
    let miseTools: Record<string, string> | undefined
    let miseCheck: Check | undefined
    if (miseFile) {
      try {
        miseTools = parseMiseTools(readToml(join(root, miseFile)).tools)
      } catch (e) {
        miseCheck = checkUnreadable('mise', 'mise.toml versions', miseFile, e)
      }
    }
    const detected: Record<string, string | undefined> = {
      bun: Bun.version,
      java: java?.code === 0 ? parseJavaVersion(java.output) : undefined,
      ruby: ruby?.output.match(/ruby (\d[\w.]*)/)?.[1],
    }
    if (miseTools?.ktlint) {
      detected.ktlint = ktlint?.code === 0 ? parseKtlintVersion(ktlint.output) : undefined
    }
    if (miseTools?.node) detected.node = (await probe(['node', '--version']))?.output.trim().replace(/^v/, '')

    const wfDir = join(root, '.github/workflows')
    const workflows = existsSync(wfDir)
      ? readdirSync(wfDir)
          .filter((f) => /\.ya?ml$/.test(f))
          .map((f) => ({ file: f, text: readFileSync(join(wfDir, f), 'utf8') }))
      : []
    // The kit pin: `.kit/package.json` when the repo installs kit there, else the root package.json.
    const pkgFile = installDir(root) === '.' ? 'package.json' : `${installDir(root)}/package.json`
    const pkg = read(pkgFile)
    let pin: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> } | undefined
    let pkgCheck: Check | undefined
    try {
      pin = pkg ? JSON.parse(pkg) : undefined
    } catch (e) {
      pkgCheck = checkUnreadable('package-json', 'package.json', pkgFile, e)
    }
    const kitPin = pin?.devDependencies?.['@jordond/kit'] ?? pin?.dependencies?.['@jordond/kit']

    const catalogFile = catalogPath(config)
    let catalogCheck: Check
    try {
      const text = catalogFile ? read(catalogFile) : undefined
      catalogCheck = checkCatalogKeys(catalogFile, text === undefined ? undefined : parseToml(text))
    } catch (e) {
      catalogCheck = checkUnreadable('catalog', 'catalog keys', catalogFile ?? '', e)
    }

    const checks: Check[] = [
      checkBun(Bun.version),
      checkJava(java, gradle),
      checkRuby(ruby, fastlane),
      checkXcode(xcode, ios, process.platform),
      checkAndroidSdk(
        process.env,
        config?.gradle ? read(join(config.gradle.root, 'local.properties')) : undefined,
        existsSync,
        gradle,
      ),
      ...(toolchainRoot !== undefined
        ? [
            checkToolchain(
              toolchainRoot,
              wrapperPath && existsSync(wrapperPath) ? readFileSync(wrapperPath, 'utf8') : undefined,
              wrapperExec,
            ),
          ]
        : []),
      checkWranglerLogin(wrangler),
      ...(ktlintUsed ? [checkKtlint(ktlint, true)] : []),
      miseCheck ?? checkMise(miseTools, detected, !!Bun.which('mise')),
      checkLefthook(lefthookFile, !!Bun.which('lefthook'), lefthookHook, onGitHubActions()),
      checkEnvFile(read('.env.example'), read('.env')),
      ...(config?.release?.ios?.xcconfig ? [checkIosVersion(() => iosVersionDrift(root, config))] : []),
      ...(config?.toolchain && config.release?.android
        ? [checkAndroidVersion(() => androidVersionDrift(root, config))]
        : []),
      checkReleaseSecrets(releaseSecrets(config), process.env, onGitHubActions(), (m) =>
        renameHints(m, (old) => !!process.env[old]),
      ),
      checkCiPin(workflows, kitPin, ctx.args.ci === true),
      catalogCheck,
      ...(pkgCheck ? [pkgCheck] : []),
    ]

    const ok = !checks.some((c) => c.status === 'fail')
    if (ctx.flags.json) emitJson({ ok, checks })
    else {
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
    }
    if (!ok) process.exitCode = ExitCode.precondition
  },
})
