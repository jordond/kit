import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { KitContext } from '../cli/command'
import type { KitConfig } from '../config/schema'
import { ExitCode, KitError } from './errors'
import { detectPackageManager, pmExec } from './pm'
import { addChildEnv } from './proc'
import { type PipeResult, pipeSecret } from './secrets'

/**
 * Cloudflare helpers (ported from brewd `lib/cloudflare-account.ts`, `lib/d1.ts`, `commands/db.ts`).
 *
 * Account pinning: wrangler reads the ambient CLOUDFLARE_ACCOUNT_ID for d1, r2 and secret, and only
 * falls back to wrangler.jsonc for deploy and dev. kit's `.env` loading does not override a variable
 * the shell already exports, so an id left over from another project would silently retarget those
 * commands at the wrong account (a d1 execute against someone else's database). The pin rides on
 * every spawn via `addChildEnv`: Bun.spawn snapshots the env kit started with, so mutating
 * `process.env` would reach no child.
 */

export const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'] as const

const ACCOUNT_ID = /^[0-9a-f]{32}$/
// TOML: matched within the root table only (before the first `[table]` header), so an
// `[env.staging]` account_id is never picked up.
const TOML_ACCOUNT_ID = /^\s*account_id\s*=\s*["']([0-9a-f]{32})["']/m

/** JSONC → JSON text: drops `//` and block comments outside strings, then trailing commas. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  // Trailing commas: strings are matched first so a `,]` inside one survives.
  return out.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (_m, str: string | undefined, close: string) => str ?? close,
  )
}

function jsonAccountId(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(text))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const id = (parsed as Record<string, unknown>).account_id
    return typeof id === 'string' && ACCOUNT_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

function tomlAccountId(text: string): string | undefined {
  const header = /^\s*\[/m.exec(text)
  const top = header ? text.slice(0, header.index) : text
  return TOML_ACCOUNT_ID.exec(top)?.[1]
}

/** Top-level `account_id` from the wrangler config in `dir`, or undefined when there is none. */
export function readAccountId(dir: string): { id?: string; file?: string } {
  for (const name of WRANGLER_FILES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    return { id: name.endsWith('.toml') ? tomlAccountId(text) : jsonAccountId(text), file }
  }
  return {}
}

/** The target whose wrangler config holds the account: any `cloudflare.d1` entry's, else the first worker. */
export function accountTarget(config: KitConfig): string | undefined {
  const d1 = Object.values(config.cloudflare?.d1 ?? {})[0]
  if (d1) return d1.target
  return Object.entries(config.targets).find(([, t]) => t.kind === 'worker')?.[0]
}

/** `cloudflare.accountId` resolved: a literal id, or read from wrangler config. Undefined when unset. */
export function resolveAccountId(root: string, config: KitConfig): string | undefined {
  const configured = config.cloudflare?.accountId
  if (!configured) return undefined
  if (configured !== 'from-wrangler') return configured
  const name = accountTarget(config)
  const target = name ? config.targets[name] : undefined
  if (!name || !target) {
    throw new KitError(
      "cloudflare.accountId is 'from-wrangler' but there is no worker target to read it from",
      'Add a cloudflare.d1 entry or a worker target, or set the id literally',
      ExitCode.config,
    )
  }
  const dir = resolve(root, target.dir)
  const { id, file } = readAccountId(dir)
  if (!id) {
    const where = file ? relative(root, file) : `${target.dir}/wrangler.jsonc`
    throw new KitError(
      `No account_id in ${where}`,
      `Add "account_id" to ${where}, or set cloudflare.accountId in kit.config.ts`,
      ExitCode.config,
    )
  }
  return id
}

/** Resolve the account and pin it for every later child. Commands that run wrangler call this first. */
export function pinCloudflareAccount(root: string, config: KitConfig): string | undefined {
  const id = resolveAccountId(root, config)
  if (id) addChildEnv({ CLOUDFLARE_ACCOUNT_ID: id })
  return id
}

export interface WranglerCommand {
  cmd: string[]
  cwd: string
}

/** `wrangler …` from a target's dir, through its package manager (`bun x wrangler`). */
export function wrangler(
  root: string,
  config: KitConfig,
  target: string,
  ...args: string[]
): WranglerCommand {
  const t = config.targets[target]
  if (!t) {
    throw new KitError(
      `Unknown target "${target}"`,
      `Targets: ${Object.keys(config.targets).join(', ')}`,
      ExitCode.config,
    )
  }
  const cwd = resolve(root, t.dir)
  return { cmd: pmExec(detectPackageManager(cwd, root), 'wrangler', ...args), cwd }
}

/** `wrangler secret put <key>` with the value on stdin. */
export function wranglerSecretPut(w: WranglerCommand, value: string): Promise<PipeResult> {
  // wrangler reads the value from stdin when it isn't a TTY; it trims the trailing newline.
  return pipeSecret(w.cmd, `${value}\n`, { cwd: w.cwd })
}

/** Names from `wrangler secret list --format json` (`[{ name, type }]`); unparseable output → []. */
export function parseSecretNames(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) return []
    const names: string[] = []
    for (const entry of parsed) {
      if (typeof entry === 'object' && entry !== null && 'name' in entry) {
        const { name } = entry as { name: unknown }
        if (typeof name === 'string' && name.length > 0) names.push(name)
      }
    }
    return names
  } catch {
    return []
  }
}

// —— D1 ————————————————————————————————————————————————————————————————————

export interface D1Database {
  /** Key in `cloudflare.d1`. */
  key: string
  /** Database name wrangler knows. */
  name: string
  target: string
  default?: boolean
  /** SQL file `kit db seed` runs, relative to the repo root. */
  seed?: string
}

/**
 * The database for `--db`: a `cloudflare.d1` key or database name. Without `--db` the only one, or
 * the one marked `default: true`; with several and no default, a usage error listing them.
 */
export function resolveD1(config: KitConfig, db: string | undefined): D1Database {
  const all = Object.entries(config.cloudflare?.d1 ?? {}).map(([key, d]) => ({ key, ...d }))
  if (!all.length) {
    throw new KitError(
      'No D1 databases configured',
      "Add cloudflare.d1 in kit.config.ts, e.g. { db: { name: 'my-db', target: 'api' } }",
      ExitCode.config,
    )
  }
  const names = all.map((d) => (d.key === d.name ? d.key : `${d.key} (${d.name})`)).join(', ')
  if (db === undefined || db === '') {
    if (all.length === 1) return all[0]!
    const fallback = all.find((d) => d.default)
    if (fallback) return fallback
    throw new KitError(`Several D1 databases; pick one with --db`, `Databases: ${names}`, ExitCode.usage)
  }
  const found = all.find((d) => d.key === db) ?? all.find((d) => d.name === db)
  if (!found) throw new KitError(`Unknown D1 database "${db}"`, `Databases: ${names}`, ExitCode.usage)
  return found
}

export const locality = (remote: boolean): string => (remote ? '--remote' : '--local')

export type D1Action =
  | { kind: 'migrate'; remote: boolean }
  | { kind: 'list'; remote: boolean }
  | { kind: 'create'; migration: string }
  | { kind: 'exec'; remote: boolean; sql?: string; file?: string; json?: boolean }
  | { kind: 'export'; remote: boolean; output: string }

/** `wrangler d1 …` args for an action. Wrangler finds `migrations_dir` from its d1_databases entry. */
export function d1Args(db: D1Database, action: D1Action): string[] {
  switch (action.kind) {
    case 'migrate':
      return ['d1', 'migrations', 'apply', db.name, locality(action.remote)]
    case 'list':
      return ['d1', 'migrations', 'list', db.name, locality(action.remote)]
    case 'create':
      return ['d1', 'migrations', 'create', db.name, action.migration]
    case 'exec': {
      const source = action.file ? ['--file', action.file] : ['--command', action.sql ?? '']
      return [
        'd1',
        'execute',
        db.name,
        locality(action.remote),
        ...source,
        ...(action.json ? ['--json'] : []),
      ]
    }
    case 'export':
      return ['d1', 'export', db.name, locality(action.remote), '--output', action.output]
  }
}

/** Flags every `kit db` command takes. */
export const dbArgs = {
  db: {
    type: 'string',
    description: 'cloudflare.d1 key or database name (default: the only one, or the default: true one)',
  },
} as const

export const remoteArg = {
  remote: { type: 'boolean', description: 'Deployed D1 (default: local)' },
} as const

/** `backups/<db>-<UTC timestamp>.sql` under the repo root: where `kit db backup` writes by default. */
export function backupFile(root: string, db: D1Database, now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '')
  return join(root, 'backups', `${db.name}-${stamp}.sql`)
}

/** The database's `seed` file as an absolute path; exit 3 when none is configured or it is missing. */
export function seedFile(root: string, db: D1Database): string {
  if (!db.seed) {
    throw new KitError(
      `No seed file for ${db.name}`,
      `Set cloudflare.d1.${db.key}.seed in kit.config.ts, e.g. 'apps/${db.target}/seed.sql'`,
      ExitCode.config,
    )
  }
  const file = resolve(root, db.seed)
  if (!existsSync(file)) {
    throw new KitError(
      `Seed file ${db.seed} not found`,
      `cloudflare.d1.${db.key}.seed is relative to the repo root`,
      ExitCode.config,
    )
  }
  return file
}

/** How a `runD1` call ended. A dry run of a mutation runs nothing. */
export type D1Outcome = 'ok' | 'failed' | 'dry-run'

/**
 * Body of `kit db …`: resolve the database, pin the account, print the plan on --dry-run, confirm
 * remote mutations, run wrangler from the database's target dir with inherited stdio (wrangler's own
 * "apply N migrations?" prompt works). `--json` captures wrangler's output into one document, except
 * `exec`, where wrangler's `--json` result is the document.
 *
 * `confirm` defaults to `mutates`: a backup writes a local file (so --dry-run skips it) but changes
 * nothing remote. `json` adds fields to the document kit writes (`file` for a backup).
 */
export async function runD1(
  ctx: Pick<KitContext, 'root' | 'config' | 'flags' | 'log'> & { args: { db?: string } },
  action: D1Action,
  opts: { mutates: boolean; confirm?: boolean; json?: Record<string, unknown> },
): Promise<D1Outcome> {
  const { requireProject } = await import('../cli/command')
  const { confirm } = await import('./prompt')
  const { emitJson } = await import('./log')
  const { run, runQuiet, runToStderr } = await import('./proc')
  const { root, config } = requireProject(ctx)
  const db = resolveD1(config, ctx.args.db)
  const remote = 'remote' in action && action.remote
  const passJson = action.kind === 'exec' && ctx.flags.json
  const w = wrangler(root, config, db.target, ...d1Args(db, passJson ? { ...action, json: true } : action))
  const shown = `${relative(root, w.cwd) || '.'} $ ${w.cmd.join(' ')}`

  if (ctx.flags.dryRun && opts.mutates) {
    if (ctx.flags.json)
      emitJson({ dryRun: true, db: db.name, remote, ...opts.json, cmd: w.cmd, cwd: relative(root, w.cwd) })
    else ctx.log.step(shown)
    return 'dry-run'
  }
  pinCloudflareAccount(root, config)
  if (
    (opts.confirm ?? opts.mutates) &&
    remote &&
    !(await confirm(ctx.flags, `Run against remote ${db.name}?`))
  ) {
    throw new KitError('Cancelled', undefined, ExitCode.interrupted)
  }
  if (!ctx.flags.json) ctx.log.dim(shown)
  if (ctx.flags.json && !passJson) {
    const { code, output } = await runQuiet(w.cmd, { cwd: w.cwd })
    emitJson({ db: db.name, remote, ...opts.json, ok: code === 0, output })
    if (code !== 0) process.exitCode = ExitCode.failed
    return code === 0 ? 'ok' : 'failed'
  }
  // An export's result is the file; wrangler's progress must not land on stdout beside its path.
  const code = await (action.kind === 'export' ? runToStderr : run)(w.cmd, { cwd: w.cwd })
  if (code !== 0) process.exitCode = ExitCode.failed
  return code === 0 ? 'ok' : 'failed'
}

/** SQLite string literal (doubles embedded `'`). Values go to wrangler as one argv element, never a shell. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
