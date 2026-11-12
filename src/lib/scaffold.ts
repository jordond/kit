import { join } from 'node:path'
import { getTomlValue, parseToml } from './toml'
import { ANDROID_VERSION_NAME, getYamlScalar } from './toolchain'

/**
 * New-repo scaffolding for `kit init` (no kit.config.ts yet). Two templates:
 * - `toolchain`: layered over an existing JetBrains Kotlin Toolchain project (a `kotlin` wrapper and
 *   project.yaml). kit goes in `.kit/`, config included, and the root never gets a package.json:
 *   the toolchain's own `pnpm add` would install into it.
 * - `gradle`: kit in the root package.json, a Gradle client under apps/client.
 * Everything here is pure: files come in through `read`, and the plan lists what to write.
 * An existing file is never overwritten; .gitignore and the version catalog only gain lines.
 */

export type Template = 'toolchain' | 'gradle'
export const TEMPLATES: Template[] = ['toolchain', 'gradle']

/** Reads a repo-relative file; undefined when it does not exist. */
export type ReadFile = (repoPath: string) => string | undefined

/** A Kotlin toolchain project: the wrapper and project.yaml side by side. */
export function isToolchainRepo(exists: (repoPath: string) => boolean): boolean {
  return exists('kotlin') && exists('project.yaml')
}

/** Module dirs listed under `modules:` in project.yaml: a block or flow list of plain paths (no globs). */
export function projectModules(projectYaml: string): string[] {
  const lines = projectYaml.split('\n')
  const start = lines.findIndex((l) => /^modules\s*:/.test(l))
  if (start < 0) return []
  const clean = (raw: string) =>
    raw
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '')
  const plain = (v: string) => v !== '' && !/[*{:]/.test(v)
  const flow = lines[start]!.match(/^modules\s*:\s*\[(.*)\]/)
  if (flow) return flow[1]!.split(',').map(clean).filter(plain)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const m = line.match(/^\s*-\s*(.+?)\s*$/)
    if (!m) break
    const value = clean(m[1]!.replace(/\s+#.*$/, ''))
    if (plain(value)) out.push(value)
  }
  return out
}

/** `product: jvm/app`, or `product: { type: kmp/lib, platforms: [...] }` in block or flow form. */
export function moduleProduct(moduleYaml: string): { type?: string; platforms: string[] } {
  const short = getYamlScalar(moduleYaml, ['product'])
  if (short && !short.startsWith('{')) return { type: short, platforms: [] }
  const flow = short?.match(/type\s*:\s*([^,}\s]+)/)?.[1]
  const type = flow ?? getYamlScalar(moduleYaml, ['product', 'type'])
  const inline = (short ?? getYamlScalar(moduleYaml, ['product', 'platforms']))?.match(/\[([^\]]*)\]/)?.[1]
  if (inline !== undefined) {
    return { type, platforms: inline.split(',').flatMap((p) => (p.trim() ? [p.trim()] : [])) }
  }
  // Block list under product.platforms.
  const lines = moduleYaml.split('\n')
  const at = lines.findIndex((l) => /^\s+platforms\s*:\s*$/.test(l))
  const platforms: string[] = []
  for (const line of at < 0 ? [] : lines.slice(at + 1)) {
    const m = line.match(/^\s+-\s*([\w-]+)/)
    if (!m) break
    platforms.push(m[1]!)
  }
  return { type, platforms }
}

/** Product types of single-platform modules → the `--platform` name. */
const PRODUCT_PLATFORM: Record<string, string> = {
  jvm: 'jvm',
  android: 'android',
  'wasm-js': 'wasmJs',
  js: 'js',
}

/** Platforms a Linux CI runner can build and test, in the order they are passed. */
const LINUX_PLATFORMS = ['jvm', 'android', 'wasmJs', 'js', 'linuxX64']

export interface ToolchainFacts {
  /** `android/app` module and its applicationId (or namespace) and versionName. */
  android?: { module: string; packageName?: string; versionName?: string }
  /** `ios/app` module: its Xcode project, scheme, bundle id, and the xcconfig with MARKETING_VERSION. */
  ios?: {
    module: string
    project: string
    scheme: string
    bundleId?: string
    teamId?: string
    xcconfig?: string
    version?: string
  }
  /** `jvm/app` module, run by `kit dev`. */
  desktop?: string
  /** Non-Apple platforms across the modules, for the Linux CI job; empty runs everything. */
  ciPlatforms: string[]
}

/**
 * What the template needs from the project. `list(dir)` returns the repo-relative files under a
 * module dir (for the Xcode project, its schemes and xcconfigs).
 */
export function detectToolchain(read: ReadFile, list: (dir: string) => string[]): ToolchainFacts {
  const facts: ToolchainFacts = { ciPlatforms: [] }
  const platforms = new Set<string>()
  for (const module of projectModules(read('project.yaml') ?? '')) {
    const yaml = read(join(module, 'module.yaml'))
    if (yaml === undefined) continue
    const product = moduleProduct(yaml)
    const [kind, shape] = (product.type ?? '').split('/')
    if (kind && PRODUCT_PLATFORM[kind]) platforms.add(PRODUCT_PLATFORM[kind])
    for (const p of product.platforms) platforms.add(p)
    if (shape !== 'app') continue
    if (kind === 'android' && !facts.android) {
      facts.android = {
        module,
        packageName:
          getYamlScalar(yaml, ['settings', 'android', 'applicationId']) ??
          getYamlScalar(yaml, ['settings', 'android', 'namespace']),
        versionName: getYamlScalar(yaml, ANDROID_VERSION_NAME),
      }
    } else if (kind === 'jvm' && !facts.desktop) {
      facts.desktop = module
    } else if (kind === 'ios' && !facts.ios) {
      const files = list(module)
      const pbxproj = files.find((f) => f.endsWith('.xcodeproj/project.pbxproj'))
      const project = pbxproj?.replace(/\/project\.pbxproj$/, '') ?? join(module, 'module.xcodeproj')
      const schemes = files.flatMap((f) => f.match(/\/xcschemes\/([^/]+)\.xcscheme$/)?.[1] ?? [])
      const pbx = (pbxproj && read(pbxproj)) || ''
      const xcconfig = files
        .filter((f) => f.endsWith('.xcconfig'))
        .find((f) => /^\s*MARKETING_VERSION\s*=/m.test(read(f) ?? ''))
      const xc = (xcconfig && read(xcconfig)) || ''
      const setting = (key: string) =>
        [xc, pbx]
          .map((text) =>
            text.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^";\\n]+?)"?\\s*;?\\s*$`, 'm'))?.[1]?.trim(),
          )
          .find((v) => v && !v.includes('$('))
      facts.ios = {
        module,
        project,
        scheme: schemes.includes('app') ? 'app' : (schemes[0] ?? 'app'),
        bundleId: setting('PRODUCT_BUNDLE_IDENTIFIER'),
        teamId: setting('DEVELOPMENT_TEAM'),
        xcconfig,
        version: xcconfig ? setting('MARKETING_VERSION') : undefined,
      }
    }
  }
  facts.ciPlatforms = LINUX_PLATFORMS.filter((p) => platforms.has(p))
  return facts
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** A reverse-DNS placeholder id from the app name (`com.example.myapp`). */
export function placeholderId(name: string): string {
  return `com.example.${name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'app'}`
}

/** `.kit/kit.config.ts` for a toolchain project. Ids kit could not find are `com.example.<name>`. */
export function toolchainConfig(name: string, facts: ToolchainFacts): string {
  const id = facts.android?.packageName ?? facts.ios?.bundleId ?? placeholderId(name)
  const lines = [
    "import { defineConfig } from '@jordond/kit'",
    '',
    '// kit config: values only. Paths are relative to the repo root. https://github.com/jordond/kit',
    'export default defineConfig({',
    `  name: ${q(name)},`,
    "  toolchain: { root: '.' },",
    '  versions: {',
    "    file: 'libs.versions.toml',",
    "    keys: { ios: 'app-ios-version', android: 'app-android-version' },",
    '  },',
    '  targets: {',
    facts.desktop
      ? `    app: { kind: 'kotlin', dir: '.', dev: ${q(`./kotlin run -m ${facts.desktop}`)} },`
      : "    app: { kind: 'kotlin', dir: '.' },",
    '  },',
  ]
  const release: string[] = []
  if (facts.ios) {
    release.push(
      '    ios: {',
      `      bundleIds: [${q(facts.ios.bundleId ?? id)}],`,
      `      project: ${q(facts.ios.project)},`,
      `      scheme: ${q(facts.ios.scheme)},`,
      `      output: ${q(`${name}.ipa`)},`,
      ...(facts.ios.teamId ? [`      teamId: ${q(facts.ios.teamId)},`] : []),
      ...(facts.ios.xcconfig ? [`      xcconfig: ${q(facts.ios.xcconfig)},`] : []),
      '    },',
    )
  }
  if (facts.android) {
    release.push(
      '    android: {',
      `      packageName: ${q(facts.android.packageName ?? id)},`,
      `      module: ${q(facts.android.module)},`,
      '    },',
    )
  }
  if (release.length) lines.push('  release: {', ...release, '  },')
  lines.push('})', '')
  return lines.join('\n')
}

/** The package.json that pins kit: `.kit/package.json` (toolchain) or the root one (gradle). */
export function kitPackageJson(name: string, kitVersion: string, zod: string): string {
  const pkg = {
    name: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'app',
    private: true,
    type: 'module',
    devDependencies: { '@jordond/kit': `^${kitVersion}`, zod },
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

/**
 * An existing package.json with the kit pin added to devDependencies; undefined when it already
 * depends on kit (or is not a JSON object, which is left alone).
 */
export function withKitDependency(manifest: string, kitVersion: string, zod: string): string | undefined {
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(manifest)
  } catch {
    return undefined
  }
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) return undefined
  const deps = (k: string) => (pkg[k] ?? {}) as Record<string, string>
  if (deps('devDependencies')['@jordond/kit'] || deps('dependencies')['@jordond/kit']) return undefined
  const dev: Record<string, string> = { ...deps('devDependencies'), '@jordond/kit': `^${kitVersion}` }
  if (!dev.zod && !deps('dependencies').zod) dev.zod = zod
  return `${JSON.stringify({ ...pkg, devDependencies: dev }, null, 2)}\n`
}

/** `text` plus the `entries` it does not list yet; undefined when nothing is missing. */
export function withGitignore(text: string | undefined, entries: string[]): string | undefined {
  const have = new Set((text ?? '').split('\n').map((l) => l.trim().replace(/^\//, '')))
  const missing = entries.filter((e) => !have.has(e) && !have.has(e.replace(/\/$/, '')))
  if (!missing.length) return undefined
  const base = text === undefined || text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`
  return `${base}${missing.join('\n')}\n`
}

/**
 * The catalog with any missing `[versions]` key added; undefined when all are there. A new key goes
 * right under the `[versions]` header (created at the top when the file has none). `'manual'`
 * when the file has a versions table without a plain `[versions]` header line.
 */
export function withVersionKeys(
  text: string | undefined,
  keys: Record<string, string>,
): string | 'manual' | undefined {
  const src = text ?? ''
  const missing = Object.entries(keys).filter(([k]) => getTomlValue(src, 'versions', k) === undefined)
  if (!missing.length) return undefined
  const added = missing.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
  const lines = src.split('\n')
  const header = lines.findIndex((l) => /^\s*\[versions\]\s*(#.*)?$/.test(l))
  if (header < 0) {
    // `versions` written another way (inline table, quoted or spaced header): not kit's to rewrite.
    if (parseToml(src).versions !== undefined) return 'manual'
    return `${['[versions]', ...added].join('\n')}\n${src.trim() ? `\n${src}` : ''}`
  }
  lines.splice(header + 1, 0, ...added)
  return lines.join('\n')
}

export type FileAction =
  | { kind: 'write'; path: string; content: string }
  /** An existing file that gains lines. */
  | { kind: 'edit'; path: string; content: string; note: string }
  | { kind: 'skip'; path: string; reason: string }

export interface ScaffoldInput {
  template: Template
  name: string
  /** The running kit's version; the pin is `^<version>`. */
  kitVersion: string
  /** What follows `@` in workflow `uses:` lines: `<sha> # vX.Y.Z`. */
  kitRef: string
  /** zod range for the peer dependency. */
  zod: string
  /** Template files by repo-relative destination, unrendered. */
  files: Record<string, string>
  read: ReadFile
  /** Repo-relative files under a dir (toolchain: the iOS module). */
  list?: (dir: string) => string[]
}

/** Where Renovate looks for a repo's config; the templates write the first. */
export const RENOVATE_FILES = [
  'renovate.json',
  'renovate.json5',
  '.github/renovate.json',
  '.github/renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
  '.renovaterc.json5',
]

export const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)

/** Every file the template would put in the repo, in a stable order. */
export function planScaffold(input: ScaffoldInput): FileAction[] {
  const { template, name, read } = input
  const toolchain = template === 'toolchain'
  const facts = toolchain ? detectToolchain(read, input.list ?? (() => [])) : undefined
  const vars: Record<string, string> = {
    name,
    kitVersion: input.kitVersion,
    kitRef: input.kitRef,
    platformArgs: facts?.ciPlatforms.length
      ? ` -- ${facts.ciPlatforms.map((p) => `--platform ${p}`).join(' ')}`
      : '',
  }
  const manifest = toolchain ? '.kit/package.json' : 'package.json'
  const wanted: [string, string][] = [
    ...(facts ? ([['.kit/kit.config.ts', toolchainConfig(name, facts)]] as [string, string][]) : []),
    ...Object.entries(input.files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, text]) => [path, fill(text, vars)] as [string, string]),
  ]
  const plan: FileAction[] = []
  const existing = read(manifest)
  if (existing === undefined) {
    plan.push({ kind: 'write', path: manifest, content: kitPackageJson(name, input.kitVersion, input.zod) })
  } else {
    const content = withKitDependency(existing, input.kitVersion, input.zod)
    plan.push(
      content === undefined
        ? { kind: 'skip', path: manifest, reason: 'exists' }
        : { kind: 'edit', path: manifest, content, note: 'add @jordond/kit to devDependencies' },
    )
  }
  for (const [path, content] of wanted) {
    // Renovate reads its config from several places: any of them means the repo already has one.
    const present = [path, ...(path === RENOVATE_FILES[0] ? RENOVATE_FILES : [])].find(
      (f) => read(f) !== undefined,
    )
    plan.push(
      present === undefined
        ? { kind: 'write', path, content }
        : { kind: 'skip', path, reason: present === path ? 'exists' : `${present} exists` },
    )
  }

  // backups/: `kit db backup --remote` writes production dumps there.
  const ignore = withGitignore(read('.gitignore'), ['node_modules/', '.env', 'backups/'])
  if (ignore !== undefined) {
    plan.push(
      read('.gitignore') === undefined
        ? { kind: 'write', path: '.gitignore', content: ignore }
        : { kind: 'edit', path: '.gitignore', content: ignore, note: 'add node_modules/, .env and backups/' },
    )
  }
  if (facts) {
    // The versions kit releases: start from what the project already builds with.
    const android = facts.android?.versionName ?? '1.0.0'
    const keys = { 'app-android-version': android, 'app-ios-version': facts.ios?.version ?? android }
    const catalog = withVersionKeys(read('libs.versions.toml'), keys)
    if (catalog === 'manual') {
      plan.push({
        kind: 'skip',
        path: 'libs.versions.toml',
        reason: 'add app-android-version and app-ios-version to its versions table by hand',
      })
    } else if (catalog !== undefined) {
      plan.push(
        read('libs.versions.toml') === undefined
          ? { kind: 'write', path: 'libs.versions.toml', content: catalog }
          : {
              kind: 'edit',
              path: 'libs.versions.toml',
              content: catalog,
              note: 'add app-android-version and app-ios-version',
            },
      )
    }
  }
  return plan
}
