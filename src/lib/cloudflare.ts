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

// Matched rather than parsed: fail loudly if the key moves rather than guess.
const JSON_ACCOUNT_ID = /"account_id"\s*:\s*"([0-9a-f]{32})"/
const TOML_ACCOUNT_ID = /^\s*account_id\s*=\s*["']([0-9a-f]{32})["']/m

/** `account_id` from the wrangler config in `dir`, or undefined when there is none. */
export function readAccountId(dir: string): { id?: string; file?: string } {
  for (const name of WRANGLER_FILES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    const re = name.endsWith('.toml') ? TOML_ACCOUNT_ID : JSON_ACCOUNT_ID
    return { id: re.exec(readFileSync(file, 'utf8'))?.[1], file }
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
}

/**
 * The database for `--db`: a `cloudflare.d1` key or database name. Without `--db` the only one;
 * with several, a usage error listing them.
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
  }
}

/** Flags every `kit db` command takes. */
export const dbArgs = {
  db: { type: 'string', description: 'cloudflare.d1 key or database name (default: the only one)' },
} as const

export const remoteArg = {
  remote: { type: 'boolean', description: 'Deployed D1 (default: local)' },
} as const

/**
 * Body of `kit db …`: resolve the database, pin the account, print the plan on --dry-run, confirm
 * remote mutations, run wrangler from the database's target dir with inherited stdio (wrangler's own
 * "apply N migrations?" prompt works). `--json` captures wrangler's output into one document, except
 * `exec`, where wrangler's `--json` result is the document.
 */
export async function runD1(
  ctx: Pick<KitContext, 'root' | 'config' | 'flags' | 'log'> & { args: { db?: string } },
  action: D1Action,
  opts: { mutates: boolean },
): Promise<void> {
  const { requireProject } = await import('../cli/command')
  const { confirm } = await import('./prompt')
  const { emitJson } = await import('./log')
  const { run, runQuiet } = await import('./proc')
  const { root, config } = requireProject(ctx)
  const db = resolveD1(config, ctx.args.db)
  const remote = 'remote' in action && action.remote
  const passJson = action.kind === 'exec' && ctx.flags.json
  const w = wrangler(root, config, db.target, ...d1Args(db, passJson ? { ...action, json: true } : action))
  const shown = `${relative(root, w.cwd) || '.'} $ ${w.cmd.join(' ')}`

  if (ctx.flags.dryRun && opts.mutates) {
    if (ctx.flags.json)
      emitJson({ dryRun: true, db: db.name, remote, cmd: w.cmd, cwd: relative(root, w.cwd) })
    else ctx.log.step(shown)
    return
  }
  pinCloudflareAccount(root, config)
  if (opts.mutates && remote && !(await confirm(ctx.flags, `Run against remote ${db.name}?`))) {
    throw new KitError('Cancelled', undefined, ExitCode.interrupted)
  }
  if (!ctx.flags.json) ctx.log.dim(shown)
  if (ctx.flags.json && !passJson) {
    const { code, output } = await runQuiet(w.cmd, { cwd: w.cwd })
    emitJson({ db: db.name, remote, ok: code === 0, output })
    if (code !== 0) process.exitCode = ExitCode.failed
    return
  }
  const code = await run(w.cmd, { cwd: w.cwd })
  if (code !== 0) process.exitCode = ExitCode.failed
}

/** SQLite string literal (doubles embedded `'`). Values go to wrangler as one argv element, never a shell. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
