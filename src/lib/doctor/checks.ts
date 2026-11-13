import type { KitConfig } from '../../config/schema'
import { CHROME_HINT, CHROME_MIN_MAJOR } from '../chrome'
import { dotenvAmbiguities } from '../dotenv'
import { maestroInstallHint } from '../maestro/bin'
import { wrapperVersion } from '../toolchain'
import type { Fix } from './fixes'

/**
 * The rules of `kit doctor`. Each check is a pure function over what the run probed, so the rules
 * are unit-tested without the tools. A tool the project needs (java for a Gradle root, Xcode for an
 * iOS release, …) fails; one it doesn't need only warns.
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

/**
 * The `kit` on PATH against the kit that is running. An older global kit only knows the repo
 * layouts of its own release, so its launcher can miss this repo's copy and run itself.
 * `onPath` is undefined when there is no `kit` on PATH or it is this very copy.
 */
export function checkPathKit(
  onPath: string | undefined,
  running: string,
  older: boolean,
  latest?: string,
): Check | undefined {
  if (onPath === undefined) return undefined
  if (older) {
    return {
      id: 'kit',
      label: 'kit on PATH',
      status: 'warn',
      detail: `${onPath}, older than this repo's ${running}`,
      hint: `Its launcher may run itself instead of the repo's kit: bun add -g @jordond/kit@${running}`,
    }
  }
  if (latest !== undefined) {
    return {
      id: 'kit',
      label: 'kit on PATH',
      status: 'warn',
      detail: `${onPath}, latest is ${latest}`,
      hint: 'kit upgrade --global',
    }
  }
  return { id: 'kit', label: 'kit on PATH', status: 'ok', detail: onPath }
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

/** What Maestro itself needs; MIN_JAVA is kit's own (Gradle) floor. */
export const MAESTRO_MIN_JAVA = 17

/** `maestro --version` prints the bare version; tolerate warnings or banners around it. */
export function parseMaestroVersion(output: string): string | undefined {
  return output.match(/^\s*v?(\d+\.\d+\.\d+\S*)\s*$/m)?.[1] ?? output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
}

/** Maestro for `kit qa`, `kit shots` and the flow lint: a warning, since a release never needs it. */
export function checkMaestro(probe: Probe, pinned: string | undefined): Check {
  const base = { id: 'maestro', label: 'maestro' }
  if (probe?.code !== 0) {
    return { ...base, status: 'warn', detail: 'not found', hint: maestroInstallHint(pinned) }
  }
  const version = parseMaestroVersion(probe.output)
  if (version === undefined) return { ...base, status: 'warn', detail: 'unknown version' }
  if (pinned !== undefined && pinned !== version) {
    return {
      ...base,
      status: 'warn',
      detail: `${version} (config pins ${pinned})`,
      hint: maestroInstallHint(pinned),
    }
  }
  return { ...base, status: 'ok', detail: version }
}

/**
 * Maestro runs on the JVM and needs 17+. `java` is the existing java check's result: when that
 * already fails (a Gradle repo with no usable JDK) the problem is reported once, there.
 */
export function checkMaestroJava(probe: Probe, java: Check): Check | undefined {
  const base = { id: 'maestro-java', label: 'java for maestro' }
  const hint = `Install JDK ${MAESTRO_MIN_JAVA}+ (e.g. \`mise use java@${MIN_JAVA}\`)`
  const version = probe?.code === 0 ? parseJavaVersion(probe.output) : undefined
  const major = Number(version?.split(/[.+-]/)[0])
  if (version !== undefined && major >= MAESTRO_MIN_JAVA) return { ...base, status: 'ok', detail: version }
  if (java.status === 'fail') return undefined
  const detail = version === undefined ? 'not found' : `${version} (need ${MAESTRO_MIN_JAVA}+)`
  return { ...base, status: 'warn', detail, hint }
}

/** `chrome --version` → '131.0.6778.86' ("Google Chrome 131.0.6778.86", "Chromium 120.0.6099.109 built on …"). */
export function parseChromeVersion(output: string): string | undefined {
  const version = /\b(\d+(?:\.\d+){1,3})\b/
  // The line that names the browser wins over numbers in a warning printed around it.
  return (
    output.match(new RegExp(`Chrom(?:e|ium)\\b[^\\d\\n]*${version.source}`))?.[1] ??
    output.match(version)?.[1]
  )
}

/** Chrome for `kit shots export`: a warning, since only that command needs it. */
export function checkChrome(probe: Probe): Check {
  const base = { id: 'chrome', label: 'chrome' }
  if (probe === undefined) return { ...base, status: 'warn', detail: 'not found', hint: CHROME_HINT }
  const version = probe.code === 0 ? parseChromeVersion(probe.output) : undefined
  if (version === undefined) return { ...base, status: 'warn', detail: 'unknown version', hint: CHROME_HINT }
  if (Number(version.split('.')[0]) < CHROME_MIN_MAJOR) {
    return {
      ...base,
      status: 'warn',
      detail: `${version} (need ${CHROME_MIN_MAJOR}+)`,
      hint: `Update Chrome to ${CHROME_MIN_MAJOR} or newer, or set KIT_CHROME to a newer Chrome or Chromium binary`,
    }
  }
  return { ...base, status: 'ok', detail: version }
}

/** adb for `kit app install` and `kit device`: only a warning, a release never needs it. */
export function checkAdb(path: string | undefined): Check {
  if (path) return { id: 'adb', label: 'adb', status: 'ok', detail: path }
  return missing(
    'adb',
    'adb',
    false,
    'Install Android SDK platform-tools (`sdkmanager platform-tools`, or `brew install android-platform-tools`)',
  )
}

/** What `kit device boot android` needs to create and boot an emulator. */
export function checkEmulator(found: {
  emulator: boolean
  avdmanager: boolean
  /** A phone system image for the host ABI, as an sdkmanager package; undefined when none is installed. */
  image: string | undefined
  abi: string
}): Check {
  const base = { id: 'emulator', label: 'Android emulator' }
  const lacking = [
    ...(found.emulator ? [] : ['emulator']),
    ...(found.avdmanager ? [] : ['cmdline-tools (avdmanager)']),
    ...(found.image ? [] : [`a ${found.abi} system image`]),
  ]
  if (!lacking.length) return { ...base, status: 'ok', detail: found.image }
  const packages = [
    ...(found.emulator ? [] : ['emulator']),
    ...(found.avdmanager ? [] : ['"cmdline-tools;latest"']),
    ...(found.image ? [] : [`"system-images;android-36;google_apis_playstore;${found.abi}"`]),
  ]
  return {
    ...base,
    status: 'warn',
    detail: `missing ${lacking.join(', ')}`,
    hint: `sdkmanager ${packages.join(' ')} (a connected phone works without it)`,
  }
}

/** `xcrun simctl list runtimes -j`: the newest installed iOS simulator runtime. */
export function checkSimulator(probe: Probe, platform: string): Check {
  const base = { id: 'simulator', label: 'iOS simulator' }
  if (platform !== 'darwin') return { ...base, status: 'skip', detail: 'macOS only' }
  const hint = 'Xcode ▸ Settings ▸ Components, or `xcodebuild -downloadPlatform iOS`'
  if (probe?.code !== 0) return { ...base, status: 'warn', detail: 'simctl not available', hint }
  let versions: string[] = []
  try {
    // runQuiet joins stderr after stdout: parse the JSON object only.
    const json = probe.output.slice(probe.output.indexOf('{'), probe.output.lastIndexOf('}') + 1)
    const { runtimes = [] } = JSON.parse(json) as {
      runtimes?: { identifier?: string; version?: string; isAvailable?: boolean }[]
    }
    versions = runtimes
      .filter((r) => r.isAvailable !== false && /SimRuntime\.iOS-/.test(r.identifier ?? ''))
      .map((r) => r.version ?? '')
      .filter(Boolean)
  } catch {
    return { ...base, status: 'warn', detail: 'unreadable simctl output', hint }
  }
  if (!versions.length) return { ...base, status: 'warn', detail: 'no iOS runtime installed', hint }
  const newest = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
  return { ...base, status: 'ok', detail: `iOS ${newest}` }
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
        after: 'Open a new shell (or activate mise in this one) so the installed tools are on PATH',
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
  const ambiguous = dotenvAmbiguities(env)
  if (ambiguous.length) {
    return {
      id: 'env',
      label,
      status: 'warn',
      detail: `read differently by Bun, dotenv and kit: ${[...new Set(ambiguous.map((w) => w.key))].join(', ')}`,
      hint: 'Run `kit env check` for the lines and how to write them',
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
