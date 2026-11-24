import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dotenvValue } from '../lib/dotenv'
import { ExitCode, KitError } from '../lib/errors'
import { log } from '../lib/log'
import { configSchema, type KitConfig } from './schema'

export const CONFIG_FILE = 'kit.config.ts'

/** Alternative install dir: package.json, bun.lock and node_modules under `<root>/.kit`. */
export const KIT_DIR = '.kit'

/**
 * Where the repo's kit dependency lives, repo-relative: `.kit` when `.kit/package.json` exists,
 * else `.` (the root package.json). A Kotlin toolchain repo uses `.kit`: a root package.json makes
 * the toolchain's own `pnpm add` (Kotlin/Wasm test browsers) install into the repo root.
 */
export function installDir(root: string, exists: (path: string) => boolean = existsSync): string {
  return exists(join(root, KIT_DIR, 'package.json')) ? KIT_DIR : '.'
}

let selfRegistered = false

/**
 * Make `import … from '@jordond/kit'` resolve to this running kit from any file (kit.config.ts,
 * `.kit/commands`, preflights). With the `.kit` install dir a root kit.config.ts has no
 * node_modules above it; and it keeps one kit instance either way.
 */
export function registerSelf(): void {
  if (selfRegistered) return
  selfRegistered = true
  Bun.plugin({
    name: 'kit-self',
    setup(build) {
      build.module('@jordond/kit', async () => ({ exports: await import('../index'), loader: 'object' }))
    },
  })
}

/**
 * The config file of `root`, repo-relative: `kit.config.ts`, else `.kit/kit.config.ts` (next to
 * kit's node_modules, so editors resolve the `@jordond/kit` import). The root file wins. Paths in
 * the config are relative to the repo root in both places.
 */
export function configFile(root: string, exists: (path: string) => boolean = existsSync): string | undefined {
  return [CONFIG_FILE, join(KIT_DIR, CONFIG_FILE)].find((f) => exists(join(root, f)))
}

export function findRoot(from: string = process.cwd()): string | undefined {
  if (process.env.KIT_ROOT && configFile(process.env.KIT_ROOT)) return process.env.KIT_ROOT
  let dir = from
  while (true) {
    // `.kit/kit.config.ts` belongs to the repo above it: `.kit` itself is never a root.
    if (basename(dir) !== KIT_DIR && configFile(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Load `<root>/.env` into process.env without overriding values already set. */
export async function loadDotEnv(root: string): Promise<void> {
  const file = Bun.file(join(root, '.env'))
  if (!(await file.exists())) return
  for (const line of (await file.text()).split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const [, key, raw] = m as unknown as [string, string, string]
    if (process.env[key] !== undefined) continue
    process.env[key] = dotenvValue(raw, 'env')
  }
}

export async function loadConfig(root: string, options?: LoadConfigOptions): Promise<KitConfig> {
  const file = configFile(root) ?? CONFIG_FILE
  return loadConfigFile(join(root, file), file, options)
}

export interface LoadConfigOptions {
  /** Told about keys the schema does not know; they are dropped and loading carries on. */
  warn?: (message: string, hint: string) => void
}

/**
 * Load and validate one config file; `label` names it in errors. Unknown keys warn instead of
 * failing: a config written for a newer kit (or a pulled bump without a reinstall) still runs on
 * this one, minus the settings it does not know.
 */
export async function loadConfigFile(
  path: string,
  label = CONFIG_FILE,
  {
    warn = (message, hint) => {
      log.warn(message)
      log.dim(`  › ${hint}`)
    },
  }: LoadConfigOptions = {},
): Promise<KitConfig> {
  registerSelf()
  const mod = await import(pathToFileURL(path).href)
  const { result, unknown } = parseConfig(mod.default)
  if (unknown.length) {
    warn(
      `${label}: ignoring unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.join(', ')}`,
      'A typo, or a setting from a newer kit: check the spelling or update kit',
    )
  }
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new KitError(`Invalid ${label}:\n${issues}`, 'Fix the fields above', ExitCode.config)
  }
  return result.data
}

type Key = PropertyKey

/**
 * Parse `input`, dropping keys the schema rejects as unrecognized and parsing again until only
 * other problems (or none) remain. Returns the last parse and the dotted paths of every dropped key.
 */
export function parseConfig(input: unknown): {
  result: ReturnType<typeof configSchema.safeParse>
  unknown: string[]
} {
  const unknown: string[] = []
  let value = input
  // Each pass drops at least one key; the bound only guards against a schema that never settles.
  for (let pass = 0; ; pass++) {
    const result = configSchema.safeParse(value)
    const extra = result.success
      ? []
      : result.error.issues.flatMap((i) =>
          i.code === 'unrecognized_keys' ? i.keys.map((k) => [...i.path, k]) : [],
        )
    if (!extra.length || pass >= 20) return { result, unknown }
    for (const keyPath of extra) {
      value = omit(value, keyPath)
      unknown.push(keyPath.map(String).join('.'))
    }
  }
}

/** `value` without the key at `path`, copying only the objects along the path. */
function omit(value: unknown, path: Key[]): unknown {
  if (typeof value !== 'object' || value === null || !path.length) return value
  const [head, ...rest] = path as [Key, ...Key[]]
  const copy = (Array.isArray(value) ? [...value] : { ...value }) as Record<Key, unknown>
  if (rest.length) copy[head] = omit(copy[head], rest)
  else delete copy[head]
  return copy
}
