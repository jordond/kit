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
  /**
   * Suites run in order when `--suite` is not given, in place of `defaultSuite` (`shots.suites`).
   * The app is built for the first only, and the run stops at the first suite that fails.
   */
  suites?: readonly string[]
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

/** Shared body of `kit qa` and `kit shots`: resolve the suite (or suites), run or plan, report. */
export async function runSuiteCommand(ctx: KitContext, c: SuiteCommand): Promise<void> {
  const { root, config } = requireProject(ctx)
  const args = ctx.args as Record<string, string | boolean | undefined>
  const target = parseTarget(ctx.positionals[0], c.command)
  const named = args.suite as string | undefined
  // `--suite a,b` runs both, in order, like `shots.suites`.
  const listed = named
    ?.split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  const names = listed?.length
    ? [...new Set(listed)]
    : c.suites?.length
      ? [...new Set(c.suites)]
      : [c.defaultSuite]
  const suites = names.map((name) => resolveSuite(config, name))
  if (c.tags !== undefined) {
    const tags = c.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (!tags.length) throw new KitError('--tags names no tag', 'e.g. --tags smoke,auth', ExitCode.usage)
    for (const suite of suites) suite.stages = [tags]
  }
  if (args.fixture && args['no-fixture']) {
    throw new KitError('--fixture and --no-fixture conflict', undefined, ExitCode.usage)
  }
  if (suites.length > 1 && (args.fixture || args['no-fixture'])) {
    throw new KitError(
      `--fixture and --no-fixture apply to one suite, and this runs ${names.join(', ')}`,
      `Pass --suite <name> too`,
      ExitCode.usage,
    )
  }
  const many = suites.length > 1
  const runs: { suite: string; result: SuiteResult; plan: string[][] }[] = []
  for (const [i, suite] of suites.entries()) {
    if (many && !ctx.flags.dryRun) ctx.log.step(`suite ${suite.name}`)
    const { result, plan } = await runSuite({ root, config, flags: ctx.flags, log: ctx.log }, target, {
      suite,
      device: args.device as string | undefined,
      // One build serves every suite of the run.
      noBuild: args['no-build'] === true || i > 0,
      fixture: args['no-fixture'] ? false : (args.fixture as string | undefined),
      screenshotsDir: c.out,
      junit: c.junit,
    })
    runs.push({ suite: suite.name, result, plan })
    if (!ctx.flags.dryRun && !result.ok) break
  }

  if (ctx.flags.dryRun) {
    if (ctx.flags.json) {
      emitJson(
        many
          ? { target, suites: runs.map(({ suite, plan }) => ({ suite, plan })) }
          : { suite: runs[0]!.suite, target, plan: runs[0]!.plan },
      )
    } else for (const cmd of runs.flatMap((r) => r.plan)) ctx.log.step(cmd.join(' '))
    return
  }
  const results = runs.map((r) => r.result)
  const failed = results.find((r) => !r.ok)
  if (ctx.flags.json) emitJson(many ? { target, ok: !failed, suites: results } : results[0])
  if (failed) {
    ctx.log.error(failureSummary(failed), `Maestro output: ${failed.stages.at(-1)?.outputDir}`)
    process.exitCode = ExitCode.failed
    return
  }
  ctx.log.success(successLine(c.command, results))
}

function successLine(command: 'qa' | 'shots', results: readonly SuiteResult[]): string {
  const dirs = [...new Set(results.map((r) => r.screenshotsDir).filter(Boolean))]
  if (command === 'shots' && dirs.length > 0) {
    const count = new Set(results.flatMap((r) => r.stages.flatMap((s) => s.screenshots))).size
    return `${count} screenshot${count === 1 ? '' : 's'} under ${dirs.join(', ')}`
  }
  const tags = [...new Set(results.flatMap((r) => r.stages.flatMap((s) => s.tags)))].join(', ')
  return `${tags} passed on ${results[0]!.target}`
}
