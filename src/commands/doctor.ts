import { defineCommand } from '../cli/command'
import type { KitConfig } from '../config/schema'

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
): Check {
  const label = 'mise.toml versions'
  if (!tools) return { id: 'mise', label, status: 'skip', detail: 'no mise.toml' }
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
 * Workflow `uses: jordond/kit/…@<sha> # vX.Y.Z` pins vs the package.json pin. The SHA itself isn't
 * resolved (stub): the version comment Renovate keeps next to it is compared instead.
 */
/**
 * Release secrets for the configured platforms (PLAN §9.5), by name only. Missing ones fail on
 * GitHub Actions, where a release would stop on them, and only warn locally, where most work needs
 * no signing secrets.
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
      status: onActions ? 'fail' : 'warn',
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
      hint: 'Bump the workflow SHA with the npm pin',
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
    const { join } = await import('node:path')
    const pc = (await import('picocolors')).default
    const { emitJson } = await import('../lib/log')
    const { runQuiet } = await import('../lib/proc')
    const { detectPackageManager, pmExec } = await import('../lib/pm')
    const { parseToml, readToml } = await import('../lib/toml')
    const { ExitCode } = await import('../lib/errors')

    const { onGitHubActions, releaseSecrets, renameHints } = await import('../lib/release/creds')
    const root = ctx.root ?? process.cwd()
    const config = ctx.config
    const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined)
    const probe = async (cmd: string[], cwd = root): Promise<Probe> => {
      if (!Bun.which(cmd[0]!)) return undefined
      return await runQuiet(cmd, { cwd })
    }

    const targets = Object.values(config?.targets ?? {})
    const gradle = !!config?.gradle || targets.some((t) => t.kind === 'gradle')
    const ios = !!config?.release?.ios
    const fastlane = ios || !!config?.release?.android
    const worker = Object.values(config?.targets ?? {}).find((t) => t.kind === 'worker')

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
    if (miseTools?.node) detected.node = (await probe(['node', '--version']))?.output.trim().replace(/^v/, '')

    const wfDir = join(root, '.github/workflows')
    const workflows = existsSync(wfDir)
      ? readdirSync(wfDir)
          .filter((f) => /\.ya?ml$/.test(f))
          .map((f) => ({ file: f, text: readFileSync(join(wfDir, f), 'utf8') }))
      : []
    const pkg = read('package.json')
    let pin: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> } | undefined
    let pkgCheck: Check | undefined
    try {
      pin = pkg ? JSON.parse(pkg) : undefined
    } catch (e) {
      pkgCheck = checkUnreadable('package-json', 'package.json', 'package.json', e)
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
      checkWranglerLogin(wrangler),
      miseCheck ?? checkMise(miseTools, detected),
      checkEnvFile(read('.env.example'), read('.env')),
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
