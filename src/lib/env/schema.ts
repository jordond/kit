import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import { redact, registerSecret } from '../secrets'

/**
 * The env schema (PLAN §11): `env.schema` in kit.config.ts points at a module whose default export
 * (or `schema` export) is a zod object, one key per `.env` variable.
 *
 * Per-key metadata is read from zod `.meta()`:
 *
 *   export default z.object({
 *     INTERNAL_API_SECRET: z.string().min(32).meta({ description: 'CLI → edge auth' }),
 *     PUBLIC_BASE_URL: z.url().meta({ secret: false, description: 'Public edge URL' }),
 *     CORS_ALLOWED_ORIGINS: z.string().default('').meta({ secret: false }),
 *   })
 *
 * - `secret` defaults to true: unmarked keys are treated as secret (masked prompts, redacted).
 *   Mark plain values with `secret: false`.
 * - `description` (or zod `.describe()`) is shown in `kit env init` prompts.
 * - Required = the schema rejects `undefined` (no `.optional()` or `.default()`).
 *
 * The schema module imports the repo's own zod, so it is inspected structurally, never with
 * `instanceof`. Values are never printed; validation messages are redacted.
 */

export interface EnvKey {
  name: string
  secret: boolean
  required: boolean
  description?: string
}

export interface EnvIssue {
  key: string
  message: string
}

export type EnvValues = Readonly<Record<string, string | undefined>>

/** The parts of a zod v4 schema kit relies on. */
interface ZodLike {
  safeParse(v: unknown): {
    success: boolean
    data?: unknown
    error?: { issues: { path: PropertyKey[]; message: string }[] }
  }
  meta?: () => Record<string, unknown> | undefined
  description?: string
  _zod?: { def?: { innerType?: ZodLike } }
}

interface ZodObjectLike extends ZodLike {
  shape: Record<string, ZodLike>
}

export interface EnvSchema {
  /** Keys in declaration order. */
  keys: EnvKey[]
  validate(values: EnvValues): { values: Record<string, string>; issues: EnvIssue[] }
}

const isZodObject = (v: unknown): v is ZodObjectLike =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ZodLike).safeParse === 'function' &&
  typeof (v as ZodObjectLike).shape === 'object'

/** Metadata on the field or on whatever it wraps (`.meta()` before `.optional()` lands inside). */
function fieldMeta(field: ZodLike): { secret?: unknown; description?: unknown } {
  const out: { secret?: unknown; description?: unknown } = {}
  let cur: ZodLike | undefined = field
  for (let depth = 0; cur && depth < 8; depth++) {
    const m = cur.meta?.() ?? {}
    if (out.secret === undefined && m.secret !== undefined) out.secret = m.secret
    if (out.description === undefined) out.description = m.description ?? cur.description
    cur = cur._zod?.def?.innerType
  }
  return out
}

export function describeSchema(schema: unknown): EnvSchema {
  if (!isZodObject(schema))
    throw new KitError('env schema must export a zod object', undefined, ExitCode.config)
  const keys: EnvKey[] = Object.entries(schema.shape).map(([name, field]) => {
    const meta = fieldMeta(field)
    return {
      name,
      secret: meta.secret !== false,
      required: !field.safeParse(undefined).success,
      ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
    }
  })
  return {
    keys,
    validate(values) {
      const input: Record<string, string> = {}
      for (const k of keys) {
        const v = values[k.name]
        // An empty value means unset, so `.default()` applies and required keys fail.
        if (v !== undefined && v !== '') input[k.name] = v
        if (k.secret) registerSecret(v)
      }
      const result = schema.safeParse(input)
      const merged: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) if (typeof v === 'string') merged[k] = v
      if (!result.success) {
        const issues = (result.error?.issues ?? []).map((i) => ({
          key: i.path.length ? String(i.path[0]) : '(root)',
          message: redact(i.message),
        }))
        return { values: merged, issues }
      }
      // Defaults flow into the values so outputs render them.
      for (const [k, v] of Object.entries((result.data ?? {}) as Record<string, unknown>)) {
        if (v !== undefined && v !== null) merged[k] = String(v)
      }
      return { values: merged, issues: [] }
    },
  }
}

/** A schema with no rules: every key referenced by env config, optional and secret. */
export function implicitSchema(config: KitConfig): EnvSchema {
  const names = [...new Set(referencedKeys(config))]
  const keys = names.map((name) => ({ name, secret: true, required: false }))
  return {
    keys,
    validate(values) {
      const merged: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) if (typeof v === 'string') merged[k] = v
      for (const k of names) registerSecret(values[k])
      return { values: merged, issues: [] }
    },
  }
}

/** Source keys named anywhere in `env`: output picks and renames, worker and GitHub secrets. */
export function referencedKeys(config: KitConfig): string[] {
  const env = config.env ?? {}
  return [
    ...Object.values(env.outputs ?? {}).flatMap((o) => [...(o.pick ?? []), ...Object.values(o.rename ?? {})]),
    ...Object.values(env.workerSecrets ?? {}).flat(),
    ...(env.githubSecrets ?? []),
  ]
}

/** Load `env.schema`, or the implicit schema when none is set. */
export async function loadEnvSchema(root: string, config: KitConfig): Promise<EnvSchema> {
  const path = config.env?.schema
  if (!path) return implicitSchema(config)
  const file = resolve(root, path)
  if (!existsSync(file)) {
    throw new KitError(`env.schema not found: ${path}`, 'Fix env.schema in kit.config.ts', ExitCode.config)
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; schema?: unknown }
  const schema = mod.default ?? mod.schema
  if (!isZodObject(schema)) {
    throw new KitError(
      `${path} must export a zod object (default export or \`schema\`)`,
      'export default z.object({ … })',
      ExitCode.config,
    )
  }
  return describeSchema(schema)
}

/** `Invalid .env` with one line per key; messages are already redacted. */
export function formatIssues(issues: EnvIssue[]): string {
  return `Invalid .env:\n${issues.map((i) => `  ${i.key}: ${i.message}`).join('\n')}`
}
