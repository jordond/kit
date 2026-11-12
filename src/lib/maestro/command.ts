import { type KitContext, requireProject } from '../../cli/command'
import { parseTarget } from '../devices'
import { ExitCode, KitError } from '../errors'
import { emitJson } from '../log'
import { failureSummary, runSuite, type SuiteResult } from './run'
import { requireMaestro, resolveSuite } from './suites'

interface SuiteCommand {
  command: 'qa' | 'shots'
  /** The suite when `--suite` is not given. */
  defaultSuite: string
  /** `--tags`: replaces the suite's stages with one stage. */
  tags?: string
  /** Repo-relative screenshots dir, used as is. */
  out?: string
  junit?: string
}

const EXAMPLE = `maestro: { dir: 'maestro', suites: { 'shots-full': { extends: 'shots', stages: [['screenshots'], ['screenshots-extra']] } } }`

/** `--full` names `shots-full`, which has no default: a repo defines what "full" means. */
export function requireFullSuite(ctx: KitContext): void {
  const { config } = requireProject(ctx)
  if (!requireMaestro(config).suites?.['shots-full']) {
    throw new KitError(
      'kit shots --full needs a "shots-full" suite',
      `Define it in kit.config.ts, e.g. ${EXAMPLE}`,
      ExitCode.config,
    )
  }
}

/** Shared body of `kit qa` and `kit shots`: resolve the suite, run or plan it, report. */
export async function runSuiteCommand(ctx: KitContext, c: SuiteCommand): Promise<void> {
  const { root, config } = requireProject(ctx)
  const args = ctx.args as Record<string, string | boolean | undefined>
  const target = parseTarget(ctx.positionals[0], c.command)
  const suite = resolveSuite(config, (args.suite as string | undefined) ?? c.defaultSuite)
  if (c.tags !== undefined) {
    const tags = c.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (!tags.length) throw new KitError('--tags names no tag', 'e.g. --tags smoke,auth', ExitCode.usage)
    suite.stages = [tags]
  }
  if (args.fixture && args['no-fixture']) {
    throw new KitError('--fixture and --no-fixture conflict', undefined, ExitCode.usage)
  }
  const { result, plan } = await runSuite({ root, config, flags: ctx.flags, log: ctx.log }, target, {
    suite,
    device: args.device as string | undefined,
    noBuild: args['no-build'] === true,
    fixture: args['no-fixture'] ? false : (args.fixture as string | undefined),
    screenshotsDir: c.out,
    junit: c.junit,
  })

  if (ctx.flags.dryRun) {
    if (ctx.flags.json) emitJson({ suite: suite.name, target, plan })
    else for (const cmd of plan) ctx.log.step(cmd.join(' '))
    return
  }
  if (ctx.flags.json) emitJson(result)
  if (!result.ok) {
    ctx.log.error(failureSummary(result), `Maestro output: ${result.stages.at(-1)?.outputDir}`)
    process.exitCode = ExitCode.failed
    return
  }
  ctx.log.success(successLine(c.command, result))
}

function successLine(command: 'qa' | 'shots', r: SuiteResult): string {
  if (command === 'shots' && r.screenshotsDir) {
    const count = new Set(r.stages.flatMap((s) => s.screenshots)).size
    return `${count} screenshot${count === 1 ? '' : 's'} under ${r.screenshotsDir}`
  }
  const tags = [...new Set(r.stages.flatMap((s) => s.tags))].join(', ')
  return `${tags} passed on ${r.target}`
}
