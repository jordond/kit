import type { Args } from 'gunshi'
import { requireProject } from '../cli/command'
import type { PlanOptions } from '../lib/targets'
import type { VerbContext } from './_verb'

/** `--module` and `--platform`, shared by build and test. */
export const scopeArgs = {
  module: {
    type: 'string',
    short: 'm',
    multiple: true,
    description:
      'Gradle or Kotlin toolchain: only this module (its name, directory or Gradle path); repeatable',
  },
  platform: {
    type: 'string',
    short: 'p',
    multiple: true,
    description:
      'Gradle or Kotlin toolchain: only this platform (jvm, android, iosSimulatorArm64); repeatable',
  },
} as const satisfies Args

export interface Scope {
  /** The gradle and kotlin targets the run is narrowed to; undefined without either flag. */
  targets?: string[]
  plan: Pick<PlanOptions, 'modules' | 'platforms'>
}

/** What `--module` and `--platform` ask for: the build tool's own flags, on the native targets only. */
export async function resolveScope(ctx: VerbContext): Promise<Scope> {
  const args = ctx.args as { module?: string[]; platform?: string[] }
  const modules = args.module ?? []
  const platforms = args.platform ?? []
  if (!modules.length && !platforms.length) return { plan: {} }
  const { config } = requireProject(ctx)
  const { nativeTargets } = await import('../lib/targets')
  return { targets: nativeTargets(config, ctx.positionals), plan: { modules, platforms } }
}
