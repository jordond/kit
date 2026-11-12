import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KitConfig, TargetConfig } from '../config/schema'
import { stripJsonc, WRANGLER_FILES } from './cloudflare'
import { ExitCode, KitError } from './errors'
import { parseToml } from './toml'

/**
 * Worker-kind targets beyond deploy: preview versions, rollback, logs, the dashboard, and where
 * wrangler keeps a local D1 database. Arg builders and parsers only; commands do the running.
 * Wrangler flags were checked against wrangler 4.73.
 */

export function workerTargets(config: KitConfig): string[] {
  return Object.entries(config.targets)
    .filter(([, t]) => t.kind === 'worker')
    .map(([n]) => n)
}

/** The worker target `name`, or a usage error naming the worker targets. `command` is `kit logs`. */
export function requireWorker(config: KitConfig, name: string | undefined, command: string): TargetConfig {
  const workers = workerTargets(config)
  const hint = workers.length ? `Worker targets: ${workers.join(', ')}` : 'No target has kind "worker"'
  if (!name) throw new KitError(`${command} takes a worker target`, hint, ExitCode.usage)
  const target = config.targets[name]
  if (!target) throw new KitError(`Unknown target "${name}"`, hint, ExitCode.usage)
  if (target.kind !== 'worker') {
    throw new KitError(
      `${command} supports worker targets only; "${name}" is ${target.kind}`,
      hint,
      ExitCode.usage,
    )
  }
  return target
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The wrangler config in `dir`, parsed (JSONC or TOML). Undefined when there is none or it does not parse. */
export function readWranglerConfig(dir: string): { file: string; data: Record<string, unknown> } | undefined {
  for (const name of WRANGLER_FILES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      const text = readFileSync(file, 'utf8')
      const data: unknown = name.endsWith('.toml') ? parseToml(text) : JSON.parse(stripJsonc(text))
      return isRecord(data) ? { file, data } : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The deployed worker's name: `name`, or for an env its own `name`, else wrangler's `<name>-<env>`. */
export function workerName(data: Record<string, unknown>, env?: string): string | undefined {
  const base = typeof data.name === 'string' && data.name ? data.name : undefined
  if (!env) return base
  const envs = isRecord(data.env) ? data.env[env] : undefined
  const own = isRecord(envs) && typeof envs.name === 'string' ? envs.name : undefined
  return own || (base ? `${base}-${env}` : undefined)
}

/** Cloudflare dashboard page of a worker. Without an account id the dashboard asks which account. */
export function dashboardUrl(accountId: string | undefined, worker: string): string {
  const page = `workers/services/view/${encodeURIComponent(worker)}/production`
  return accountId
    ? `https://dash.cloudflare.com/${accountId}/${page}`
    : `https://dash.cloudflare.com/?to=/:account/${page}`
}

const DNS_LABEL = 63
const ALIAS = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * A preview alias for a branch, the way wrangler derives one: lowercased, runs of other characters
 * become `-`, and `<alias>-<worker>` must fit a DNS label (a long branch is cut and gets a 4-char
 * hash). Undefined when the branch gives no valid alias (detached HEAD, a name starting with a digit).
 */
export function previewAlias(branch: string | undefined, worker: string): string | undefined {
  if (!branch || branch === 'HEAD') return undefined
  const alias = branch
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  if (!ALIAS.test(alias)) return undefined
  const room = DNS_LABEL - worker.length - 1
  if (alias.length <= room) return alias
  const keep = room - 5
  if (keep < 1) return undefined
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 4)
  return `${alias.slice(0, keep).replace(/-+$/, '')}-${hash}`
}

const envArgs = (env: string | undefined): string[] => (env ? ['--env', env] : [])

/** `wrangler versions upload`: a new version, production traffic untouched. */
export function versionsUploadArgs(opts: { env?: string; alias?: string; extra?: string[] } = {}): string[] {
  return [
    'versions',
    'upload',
    ...envArgs(opts.env),
    ...(opts.alias ? ['--preview-alias', opts.alias] : []),
    ...(opts.extra ?? []),
  ]
}

export interface VersionUpload {
  version?: string
  /** The alias URL when wrangler printed one, else the per-version preview URL. */
  url?: string
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes
const ANSI = /\x1b\[[0-9;]*m/g

/** Version id and preview URL from `wrangler versions upload` output. */
export function parseVersionUpload(output: string): VersionUpload {
  const text = output.replace(ANSI, '')
  const find = (label: string) => new RegExp(`^\\s*${label}:\\s*(\\S+)`, 'm').exec(text)?.[1]
  return {
    version: find('Worker Version ID'),
    url: find('Version Preview Alias URL') ?? find('Version Preview URL'),
  }
}

/** `wrangler rollback [version-id]`; `--yes` because kit has already asked. */
export function rollbackArgs(opts: { to?: string; env?: string; message: string }): string[] {
  return ['rollback', ...(opts.to ? [opts.to] : []), ...envArgs(opts.env), '--message', opts.message, '--yes']
}

/** `wrangler tail`, with anything after `--` passed through. */
export function tailArgs(opts: { env?: string; extra?: string[] } = {}): string[] {
  return ['tail', ...envArgs(opts.env), ...(opts.extra ?? [])]
}

/**
 * The target and env a release service deploys, read from its `deploy` command
 * (`kit deploy api --env prod`). Undefined when the deploy is anything else: only a `kit deploy` of
 * exactly one target can be rolled back.
 */
export function serviceDeployTarget(deploy: string): { target: string; env?: string } | undefined {
  const tokens = deploy.trim().split(/\s+/)
  if (tokens[0] !== 'kit' || tokens[1] !== 'deploy') return undefined
  const targets: string[] = []
  let env: string | undefined
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--') break
    if (t === '--env' || t === '-e') env = tokens[++i]
    else if (t.startsWith('--env=')) env = t.slice('--env='.length)
    else if (!t.startsWith('-')) targets.push(t)
  }
  return targets.length === 1 ? { target: targets[0]!, env } : undefined
}

/** Marks kit's preview comment on a PR, so the next preview of the same target updates it. */
export const previewMarker = (target: string): string => `<!-- kit:preview ${target} -->`

export function previewComment(p: { target: string; url: string; version?: string; env?: string }): string {
  const what = `\`${p.target}\`${p.env ? ` (${p.env})` : ''}`
  return [
    previewMarker(p.target),
    `Preview of ${what}: ${p.url}`,
    ...(p.version ? ['', `Version \`${p.version}\``] : []),
  ].join('\n')
}

/**
 * The PR for the current branch and kit's earlier preview comment on it, from
 * `gh pr view --json number,comments`. The comment's REST id is the tail of its URL.
 */
export function parsePr(stdout: string, target: string): { number: number; commentId?: string } | undefined {
  try {
    const pr: unknown = JSON.parse(stdout)
    if (!isRecord(pr) || typeof pr.number !== 'number') return undefined
    const comments: unknown[] = Array.isArray(pr.comments) ? pr.comments : []
    const marker = previewMarker(target)
    for (const c of comments) {
      if (!isRecord(c) || typeof c.body !== 'string' || typeof c.url !== 'string') continue
      if (c.body.includes(marker)) {
        return { number: pr.number, commentId: /issuecomment-(\d+)/.exec(c.url)?.[1] }
      }
    }
    return { number: pr.number }
  } catch {
    return undefined
  }
}

// —— local D1 state ————————————————————————————————————————————————————————

const D1_OBJECT = 'miniflare-D1DatabaseObject'

/** Miniflare's file name for a local database: an HMAC of its id under the D1 object's key. */
export function localD1Hash(id: string): string {
  const key = createHash('sha256').update(D1_OBJECT).digest()
  const name = createHmac('sha256', key).update(id).digest().subarray(0, 16)
  const mac = createHmac('sha256', key).update(name).digest().subarray(0, 16)
  return Buffer.concat([name, mac]).toString('hex')
}

/**
 * The id wrangler keys a local database by: `preview_database_id`, else `database_id`, else the
 * binding. Looked up in the wrangler config's `d1_databases` by database name or binding.
 */
export function localD1Id(data: Record<string, unknown>, database: string): string | undefined {
  const list: unknown[] = Array.isArray(data.d1_databases) ? data.d1_databases : []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    if (entry.database_name !== database && entry.binding !== database) continue
    for (const key of ['preview_database_id', 'database_id', 'binding']) {
      const v = entry[key]
      if (typeof v === 'string' && v) return v
    }
  }
  return undefined
}

/** Where wrangler keeps a worker's local D1 databases. */
export const localD1StateDir = (dir: string): string => join(dir, '.wrangler/state/v3/d1')

/** Every `.sqlite` file under the local D1 state dir, whichever database it belongs to; none when the dir is absent. */
export function localD1Sqlite(dir: string): string[] {
  const state = localD1StateDir(dir)
  if (!existsSync(state)) return []
  return [...new Bun.Glob('**/*.sqlite').scanSync({ cwd: state, onlyFiles: true, dot: true })].map((f) =>
    join(state, f),
  )
}

/** The SQLite files (with WAL sidecars) of one local database under a worker dir. */
export function localD1Files(dir: string, id: string): string[] {
  const base = join(localD1StateDir(dir), D1_OBJECT, `${localD1Hash(id)}.sqlite`)
  return [base, `${base}-shm`, `${base}-wal`]
}
