import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

export function findRoot(from: string = process.cwd()): string | undefined {
  if (process.env.KIT_ROOT && existsSync(join(process.env.KIT_ROOT, CONFIG_FILE))) return process.env.KIT_ROOT
  let dir = from
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir
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
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2')
  }
}

export async function loadConfig(root: string): Promise<KitConfig> {
  registerSelf()
  const mod = await import(pathToFileURL(join(root, CONFIG_FILE)).href)
  const result = configSchema.safeParse(mod.default)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new KitError(`Invalid ${CONFIG_FILE}:\n${issues}`, 'Fix the fields above', ExitCode.config)
  }
  return result.data
}
