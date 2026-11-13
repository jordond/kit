import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { requireProject } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import { CHROME_HINT, chromeBin } from '../chrome'
import { ExitCode, KitError } from '../errors'
import { emitJson, type Logger } from '../log'
import { resolveSuite } from '../maestro/suites'
import { metadataDirs } from '../release/metadata'
import { isGenericFamily } from './fonts'
import { pageBundle } from './page-bundle'
import { isLocale, planExport, repoPath } from './plan'
import { loadProject } from './project'
import { renderJobs } from './render'
import { APPLE_MAX_PER_CLASS, PLAY_MAX_PER_TYPE, type Store } from './sizes'
import type { ExportOptions, ExportPlan, ExportResult, ExportShots, Project, StoreDestination } from './types'
import { statOrSkip, writeExport } from './write'

type Shots = NonNullable<KitConfig['shots']>

/** The release platform whose listing dir a store's screenshots go to. */
const STORE_PLATFORM = { apple: 'ios', google: 'android' } as const

const STORE_NAME: Record<Store, string> = { apple: 'the App Store', google: 'Play' }

/** What each store keeps per set and locale; deliver drops the rest without failing, so export refuses first. */
const STORE_MAX: Record<Store, number> = { apple: APPLE_MAX_PER_CLASS, google: PLAY_MAX_PER_TYPE }

/**
 * Dirs of an iOS metadata dir that deliver does not read as a locale, lower-cased (deliver compares
 * without case). From fastlane 2.241.2, `deliver/lib/deliver/loader.rb` and `upload_metadata.rb`:
 * the dirs it skips (`EXCEPTION_DIRECTORIES`: its three contact dirs, supply's `android` in a shared
 * `fastlane/metadata`, frameit's `fonts`) and its special dirs (`SPECIAL_DIR_NAMES`: `default`, text
 * for every locale, and `appleTV` and `iMessage`, which hold locale dirs of their own that export
 * does not write).
 */
const IOS_NOT_LOCALES = new Set([
  'trade_representative_contact_information',
  'review_information',
  'app_clip_review_information',
  'android',
  'fonts',
  'default',
  'appletv',
  'imessage',
])

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const lines = (items: readonly string[]): string => items.map((item) => `  ${item}`).join('\n')

export function requireShots(config: KitConfig): Shots {
  if (!config.shots) {
    throw new KitError(
      'No shots block in kit.config.ts',
      "Add shots: { project: '<saved project>.json' } to kit.config.ts",
      ExitCode.config,
    )
  }
  return config.shots
}

/**
 * The locale dirs of a store's metadata dir, sorted; none when the dir is absent. An entry that
 * fails to stat (a dangling symlink) is not one.
 */
function listingLocales(store: Store, dir: string): string[] {
  if (!existsSync(dir)) return []
  // A dir that cannot be a locale (`Old Backup`) is somebody's own, not a reason to stop.
  return readdirSync(dir)
    .filter(
      (entry) =>
        !entry.startsWith('.') &&
        isLocale(entry) &&
        !(store === 'apple' && IOS_NOT_LOCALES.has(entry.toLowerCase())) &&
        statOrSkip(join(dir, entry))?.isDirectory() === true,
    )
    .sort()
}

/**
 * The locales each store's metadata dir has, `['en-US']` for a store with none (or no metadata
 * configured): the locales an export without `--locale` would use.
 */
export function storeLocales(root: string, config: KitConfig): Record<Store, string[]> {
  const of = (store: Store): string[] => {
    const platform = STORE_PLATFORM[store]
    if (!config.release?.[platform]?.metadata) return ['en-US']
    const listed = listingLocales(store, metadataDirs(root, config, platform).dir)
    return listed.length > 0 ? listed : ['en-US']
  }
  return { apple: of('apple'), google: of('google') }
}

/**
 * Where each exported store's screenshots go and in which locales. A store's locales are the
 * locale dirs of its metadata dir narrowed by `--locale`; a store with no locale dir yet exports
 * the `--locale` ones as given, or `en-US`.
 */
export function resolveDestinations(
  root: string,
  config: KitConfig,
  opts: ExportOptions,
): StoreDestination[] {
  // A blank value is a mistake (an unset variable), never the default: a blank `out` would resolve
  // to the repo root, or to a directory named " ". The command also scans its argv, because the
  // parser drops an empty value; this covers every other caller.
  if (opts.out !== undefined && opts.out.trim() === '') {
    throw new KitError('--out has an empty value', 'e.g. --out build/store-shots', ExitCode.usage)
  }
  if (opts.locales?.some((locale) => locale.trim() === '')) {
    throw new KitError('--locale has an empty value', 'e.g. --locale en-US,fr-FR', ExitCode.usage)
  }
  if (opts.stores.length === 0) {
    throw new KitError('No store to export', '--store takes apple, google or both', ExitCode.usage)
  }
  const available: string[] = []
  const destinations = opts.stores.map((store): StoreDestination => {
    const platform = STORE_PLATFORM[store]
    const configured = Boolean(config.release?.[platform]?.metadata)
    if (!configured && opts.out === undefined) {
      const others = opts.stores.filter((s) => s !== store)
      throw new KitError(
        `No release.${platform}.metadata in kit.config.ts, so ${STORE_NAME[store]} screenshots have no destination`,
        `Set release.${platform}.metadata to the store metadata directory${others.length ? `, export with --store ${others.join(',')}` : ''}, or pass --out <dir>`,
        ExitCode.usage,
      )
    }
    const dirs = configured ? metadataDirs(root, config, platform) : undefined
    const dir =
      opts.out !== undefined
        ? join(resolve(root, opts.out), store)
        : store === 'apple'
          ? dirs!.screenshotsDir!
          : dirs!.dir
    const listed = dirs ? listingLocales(store, dirs.dir) : []
    available.push(`${store}: ${listed.length ? listed.join(', ') : 'none yet'}`)
    if (listed.length === 0) return { store, dir, locales: opts.locales ?? ['en-US'] }
    const locales = opts.locales ? listed.filter((l) => opts.locales!.includes(l)) : listed
    return { store, dir, locales }
  })

  const exported = new Set(destinations.flatMap((d) => d.locales))
  const unknown = (opts.locales ?? []).filter((l) => !exported.has(l))
  if (unknown.length > 0) {
    throw new KitError(
      `No exported store has the ${unknown.length === 1 ? 'locale' : 'locales'} ${unknown.join(', ')}`,
      `Locale dirs in the store metadata (${available.join('; ')})`,
      ExitCode.usage,
    )
  }
  return destinations
}

/** The absolute dir of the raw shots: `shots.raw`, else the `shots` suite's screenshots dir. */
export function resolveRawDir(root: string, config: KitConfig, shots: Shots): string {
  const raw = shots.raw ?? (config.maestro ? resolveSuite(config, 'shots').screenshots : undefined)
  if (!raw) {
    throw new KitError(
      'kit shots export does not know where the raw shots are',
      'Set shots.raw in kit.config.ts to the dir holding <target>/<shot>.png',
      ExitCode.config,
    )
  }
  return resolve(root, raw)
}

/**
 * Every file under `dir` as a `/`-separated path relative to it; empty when the dir is absent. An
 * entry that fails to stat (a dangling symlink) is left out, so a slide that needs it is missing.
 */
function listRaw(dir: string): Set<string> {
  const files = new Set<string>()
  const visit = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at)) {
      if (entry.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${entry}` : entry
      const stat = statOrSkip(join(at, entry))
      if (stat?.isDirectory()) visit(join(at, entry), rel)
      else if (stat) files.add(rel)
    }
  }
  if (statOrSkip(dir)?.isDirectory()) visit(dir, '')
  return files
}

/**
 * A family the page draws text in has to be loaded from `shots.fonts`: canvas text in an unknown
 * family falls back to the browser's sans-serif without an error.
 */
function checkFonts(shots: Shots, plan: ExportPlan): void {
  const declared = new Set((shots.fonts ?? []).map((font) => font.family))
  const known = (family: string): boolean => declared.has(family) || isGenericFamily(family)
  const problems = new Set<string>()
  const families = new Set<string>()
  const undeclared = (what: string, family: string): void => {
    if (known(family)) return
    families.add(family)
    problems.add(`${what} uses "${family}"`)
  }
  for (const { slide } of plan.jobs) {
    const name = `slide "${slide.name}" (${slide.id})`
    if (slide.headline.text.trim()) undeclared(`${name} headline`, slide.headline.fontFamily)
    // The badge and the brand wordmark have no family of their own: the page draws them in
    // `shots.brand.font`, else in the headline family, whether or not the headline has text.
    if (!shots.brand?.font) {
      if (slide.badge.enabled && slide.badge.text.trim()) {
        undeclared(`${name} badge (drawn in the headline family)`, slide.headline.fontFamily)
      }
      const lockup = slide.showMascot && slide.mascotPosition === 'top-center'
      if (lockup && shots.brand?.wordmark?.trim()) {
        undeclared(`${name} brand wordmark (drawn in the headline family)`, slide.headline.fontFamily)
      }
    }
    if (slide.subheadline.text.trim()) undeclared(`${name} subheadline`, slide.subheadline.fontFamily)
  }
  if (shots.brand?.font && plan.jobs.length > 0) undeclared('shots.brand.font', shots.brand.font)
  if (problems.size === 0) return
  const example = [...families][0]
  throw new KitError(
    `${plural(families.size, 'font family is', 'font families are')} not declared in shots.fonts:\n${lines([...problems])}`,
    `Add { family: '${example}', file: '<woff2 or ttf>' } to shots.fonts in kit.config.ts; an undeclared family would render in a fallback font`,
    ExitCode.config,
  )
}

/** A set with more slides than its store keeps would lose the extra ones at push. */
function checkCounts(plan: ExportPlan, project: string): void {
  const counts = new Map<string, { store: Store; set: string; count: number }>()
  for (const job of plan.jobs) {
    const key = `${job.store} ${job.set}`
    const at = counts.get(key) ?? { store: job.store, set: job.set, count: 0 }
    at.count = Math.max(at.count, job.index)
    counts.set(key, at)
  }
  const over = [...counts.values()].filter((c) => c.count > STORE_MAX[c.store])
  if (over.length === 0) return
  throw new KitError(
    `Too many slides:\n${lines(over.map((c) => `${c.set}: ${plural(c.count, 'slide')}, ${STORE_NAME[c.store]} keeps at most ${STORE_MAX[c.store]} per set and locale`))}`,
    `Remove slides from ${project}, or export one store with --store`,
    ExitCode.precondition,
  )
}

/** The font and brand files the page loads all have to be there before Chrome starts. */
function checkAssets(root: string, plan: ExportPlan): void {
  const missing = plan.assets.filter((file) => !existsSync(file)).map((file) => repoPath(root, file))
  if (missing.length === 0) return
  throw new KitError(
    `${plural(missing.length, 'font or brand file is', 'font or brand files are')} missing:\n${lines(missing)}`,
    'shots.fonts and shots.brand in kit.config.ts name files relative to the repo root',
    ExitCode.precondition,
  )
}

/** The Chrome binary, checked to be a file kit can run: a bad path would otherwise fail inside the spawn. */
function requireChrome(): string {
  const chrome = chromeBin()
  try {
    if (!statSync(chrome).isFile()) throw new Error('not a file')
    accessSync(chrome, constants.X_OK)
  } catch {
    throw new KitError(`${chrome} is not a Chrome binary kit can run`, CHROME_HINT, ExitCode.precondition)
  }
  return chrome
}

/** Per store and locale: how many screenshots of each set and their size; then what was removed and skipped. */
function report(log: Logger, result: ExportResult): void {
  const { dryRun, written, removed, skipped } = result
  if (dryRun) for (const shot of written) log.step(`${shot.file} (${shot.width}x${shot.height})`)
  const groups = new Map<string, Map<string, number>>()
  for (const shot of written) {
    const sets = groups.get(`${shot.store} ${shot.locale}`) ?? new Map<string, number>()
    const set = `${shot.set} ${shot.width}x${shot.height}`
    sets.set(set, (sets.get(set) ?? 0) + 1)
    groups.set(`${shot.store} ${shot.locale}`, sets)
  }
  for (const [group, sets] of groups) {
    log.info(`${group}: ${[...sets].map(([set, count]) => `${count} x ${set}`).join(', ')}`)
  }
  for (const file of removed) log.info(`${dryRun ? 'would remove' : 'removed'} ${file}`)
  for (const s of skipped) {
    log.warn(`Skipped slide ${s.slide} (${s.set}, ${s.locale}): no raw shot ${s.shot}`)
  }
  if (written.length === 0) {
    log.warn('Nothing to export: no slide has a raw shot in an exported locale')
    return
  }
  const count = plural(written.length, 'screenshot')
  if (dryRun) log.info(`Dry run: ${count} would be written; Chrome was not started`)
  else log.success(`${count} written`)
}

/** The project file as an error names it. */
function projectLabel(root: string, file: string, project: Project): string {
  return `${repoPath(root, file)} (${plural(project.slides.length, 'slide')})`
}

/** What one export run needs beyond the options: whether to render, and where to report progress. */
export interface ExportRun {
  dryRun: boolean
  /** One line when rendering starts. */
  step?: (message: string) => void
  /** Chrome's own chatter, for `--verbose`. */
  verbose?: (message: string) => void
}

/**
 * Plan, render in headless Chrome and write to the store listing dirs. The body of `kit shots
 * export` and of the studio's export route: it throws a KitError and prints nothing.
 */
export async function runExport(
  root: string,
  config: KitConfig,
  opts: ExportOptions,
  run: ExportRun,
): Promise<ExportResult> {
  const shots = requireShots(config)
  const projectFile = resolve(root, shots.project)
  const project = await loadProject(projectFile)
  const destinations = resolveDestinations(root, config, opts)
  const rawDir = resolveRawDir(root, config, shots)

  const plan = planExport({
    root,
    config,
    project,
    destinations,
    rawDir,
    raw: listRaw(rawDir),
    allowMissing: opts.allowMissing,
  })
  checkCounts(plan, projectLabel(root, projectFile, project))
  checkFonts(shots, plan)
  checkAssets(root, plan)

  // The dry pass does every ownership check, so a file in the way stops the run before Chrome starts.
  const planned = await writeExport(plan, { root, force: opts.force, dryRun: true })
  let outcome = planned
  if (!run.dryRun && plan.jobs.length > 0) {
    const chrome = requireChrome()
    run.step?.(`Rendering ${plural(plan.jobs.length, 'screenshot')} in headless Chrome`)
    const images = await renderJobs(plan, {
      chrome,
      page: await pageBundle(),
      root,
      verbose: run.verbose,
    })
    outcome = await writeExport(plan, { root, images, force: opts.force, dryRun: false })
  }

  return {
    dryRun: run.dryRun,
    stores: plan.stores,
    written: outcome.written,
    removed: outcome.removed,
    skipped: plan.skipped,
  }
}

/** `kit shots export`: `runExport`, then the report (or the `--json` document). */
export const exportShots: ExportShots = async (ctx, opts) => {
  const { root, config } = requireProject(ctx)
  const result = await runExport(root, config, opts, {
    dryRun: ctx.flags.dryRun,
    step: ctx.flags.json ? undefined : (message) => ctx.log.step(message),
    verbose: ctx.flags.verbose ? (message) => ctx.log.dim(message) : undefined,
  })
  if (ctx.flags.json) emitJson(result)
  else report(ctx.log, result)
}
