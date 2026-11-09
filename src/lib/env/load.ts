import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import { type EnvIssue, type EnvSchema, type EnvValues, formatIssues, loadEnvSchema } from './schema'

/** What every `kit env` command starts from: the schema and `.env` validated against it. */
export interface EnvState {
  schema: EnvSchema
  /** `.env` values (kit loaded it into the process env) with schema defaults applied. */
  values: Record<string, string>
  issues: EnvIssue[]
}

export async function loadEnv(
  root: string,
  config: KitConfig,
  raw: EnvValues = process.env,
): Promise<EnvState> {
  if (!config.env) {
    throw new KitError('No env section in kit.config.ts', 'Add env: { schema, outputs, … }', ExitCode.config)
  }
  const schema = await loadEnvSchema(root, config)
  const { values, issues } = schema.validate(raw)
  return { schema, values, issues }
}

/** Throw exit 3 listing invalid keys (names and redacted messages only). */
export function assertValid(state: EnvState): void {
  if (state.issues.length) {
    throw new KitError(formatIssues(state.issues), 'Fix .env, or run `kit env init`', ExitCode.config)
  }
}
