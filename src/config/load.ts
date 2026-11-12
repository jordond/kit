import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dotenvValue } from '../lib/dotenv'
import { ExitCode, KitError } from '../lib/errors'
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

export async function loadConfig(root: string): Promise<KitConfig> {
  const file = configFile(root) ?? CONFIG_FILE
  return loadConfigFile(join(root, file), file)
}

/** Load and validate one config file; `label` names it in errors. */
export async function loadConfigFile(path: string, label = CONFIG_FILE): Promise<KitConfig> {
  registerSelf()
  const mod = await import(pathToFileURL(path).href)
  const result = configSchema.safeParse(mod.default)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new KitError(`Invalid ${label}:\n${issues}`, 'Fix the fields above', ExitCode.config)
  }
  return result.data
}
