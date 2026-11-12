import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import pc from 'picocolors'
import type { KitContext } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import { interrupted } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { appFastlaneDir } from '../fastlane'
import { emitJson } from '../log'
import { runPiped } from '../proc'
import { confirm } from '../prompt'
import { runSteps, type StepResult, summarize } from '../steps'
import { appleCreds, onGitHubActions, playCreds } from './creds'
import {
  checkListingImages,
  type ImagePreflight,
  imageLocales,
  imageSummary,
  listingImageFiles,
} from './listing-images'
import { laneConfigEnv, laneStep, type Platform } from './mobile'

/**
 * `kit release metadata pull|push <ios|android>`: the store listing (text, screenshots) kept in the
 * repo in fastlane's layouts: deliver's for iOS (`<locale>/name.txt`, …, screenshots in a sibling
 * `screenshots/` dir), supply's for Android (`<locale>/title.txt`, …, `<locale>/images/`).
 * Never a binary, a review submission or a rollout: `kit release ios|android` owns those, and the
 * Play changelogs it writes at upload time.
 */

export type MetadataAction = 'pull' | 'push'

export const PLATFORMS = ['ios', 'android'] as const

/** supply's AVAILABLE_METADATA_FIELDS; `changelogs/` is left to `kit release android`. */
const PLAY_FIELDS = ['title', 'short_description', 'full_description', 'video']
/** supply's dir inside a shared `fastlane/metadata`; deliver skips it too. */
const SUPPLY_DIR = 'android'
/**
 * deliver's dir for the App Review contact and the demo account's user and password, in plaintext.
 * kit never keeps it in the repo: a pull removes it, a push neither lists nor uploads it.
 */
export const REVIEW_DIR = 'review_information'

export interface MetadataDirs {
  /** Absolute metadata directory (`release.<platform>.metadata`). */
  dir: string
  /** iOS only: deliver's screenshots directory, next to `dir`. */
  screenshotsDir?: string
}

export interface ListingFiles {
  /** Listing text files, absolute, sorted. */
  text: string[]
  /** The images the uploader would take (`listingImageFiles`), absolute, in upload order. */
  images: string[]
}

/** `<ios|android>` from the first positional, or a usage error. */
export function metadataPlatform(action: MetadataAction, value: string | undefined): Platform {
  if (value !== 'ios' && value !== 'android') {
    throw new KitError(
      `kit release metadata ${action} needs a platform: ${PLATFORMS.join(' | ')}${value ? ` (got "${value}")` : ''}`,
      `kit release metadata ${action} ios`,
      ExitCode.usage,
    )
  }
  return value
}

/** The configured metadata directory, or a usage error naming the config key. */
export function metadataDirs(root: string, config: KitConfig, platform: Platform): MetadataDirs {
  const path = config.release?.[platform]?.metadata
  if (!path) {
    throw new KitError(
      `No release.${platform}.metadata in kit.config.ts`,
      `Set release.${platform}.metadata to the store metadata directory, relative to the repo root (fastlane's ${platform === 'ios' ? 'deliver' : 'supply'} layout)`,
      ExitCode.usage,
    )
  }
  const dir = isAbsolute(path) ? path : resolve(root, path)
  return platform === 'ios' ? { dir, screenshotsDir: join(dirname(dir), 'screenshots') } : { dir }
}

/** Files under `dir` that `keep` accepts, sorted; dot entries and whatever `skip` names are left out. */
function walk(
  dir: string,
  keep: (file: string) => boolean,
  skip: (entry: string, depth: number) => boolean = () => false,
): string[] {
  const out: string[] = []
  const visit = (d: string, depth: number) => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d).sort()) {
      if (entry.startsWith('.') || skip(entry, depth)) continue
      const path = join(d, entry)
      if (statSync(path).isDirectory()) visit(path, depth + 1)
      else if (keep(entry)) out.push(path)
    }
  }
  visit(dir, 0)
  return out
}

/** The listing files on disk for a platform. */
export function listingFiles(platform: Platform, dirs: MetadataDirs): ListingFiles {
  if (platform === 'ios') {
    return {
      text: walk(
        dirs.dir,
        (f) => f.endsWith('.txt'),
        (e, depth) => depth === 0 && (e === SUPPLY_DIR || e === REVIEW_DIR),
      ),
      images: dirs.screenshotsDir
        ? listingImageFiles('ios', dirs.screenshotsDir).files.map((f) => f.path)
        : [],
    }
  }
  const text: string[] = []
  const images = listingImageFiles('android', dirs.dir).files.map((f) => f.path)
  if (!existsSync(dirs.dir)) return { text, images }
  for (const locale of readdirSync(dirs.dir).sort()) {
    const base = join(dirs.dir, locale)
    if (locale.startsWith('.') || !statSync(base).isDirectory()) continue
    for (const field of PLAY_FIELDS) {
      const file = join(base, `${field}.txt`)
      if (existsSync(file)) text.push(file)
    }
  }
  return { text, images }
}

/**
 * What `push` sends: text unless `withText` is off (`--only-screenshots`), images only with
 * `--screenshots`. Paths relative to `root`.
 */
export function pushPlan(
  root: string,
  platform: Platform,
  dirs: MetadataDirs,
  screenshots: boolean,
  withText = true,
): { text: string[]; images: string[]; files: string[] } {
  const found = listingFiles(platform, dirs)
  const rel = (p: string) => relative(root, p)
  const text = withText ? found.text.map(rel) : []
  const images = screenshots ? found.images.map(rel) : []
  return { text, images, files: [...text, ...images] }
}

/**
 * Uncommitted changes under `paths` (`git status --porcelain` lines): what a pull would overwrite
 * with no way back. Outside a git repo, every existing file counts. `excludes` are globs relative
 * to `root` for what sits under `paths` but the pull never writes.
 */
export async function dirtyUnder(root: string, paths: string[], excludes: string[] = []): Promise<string[]> {
  const { code, stdout } = await runPiped(
    [
      'git',
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      ...paths,
      ...excludes.map((g) => `:(exclude,glob)${g}`),
    ],
    { cwd: root },
  )
  if (code === 0) return stdout.split('\n').filter(Boolean)
  const globs = excludes.map((g) => new Bun.Glob(g))
  return paths
    .flatMap((p) => walk(p, () => true).map((f) => relative(root, f)))
    .filter((f) => !globs.some((g) => g.match(f)))
    .map((f) => `?? ${f}`)
}

/**
 * What a pull writes, for the dirty check: the metadata dir, plus deliver's screenshots dir with
 * `--screenshots` (iOS). Left out: supply's `android/` and `review_information/` (removed after
 * every pull) inside an iOS metadata dir, and supply's `<locale>/images/` when an Android pull is
 * text only.
 */
export function pullScope(
  root: string,
  platform: Platform,
  dirs: MetadataDirs,
  screenshots: boolean,
): { targets: string[]; excludes: string[] } {
  const rel = relative(root, dirs.dir)
  if (platform === 'ios') {
    return {
      targets: [dirs.dir, ...(screenshots && dirs.screenshotsDir ? [dirs.screenshotsDir] : [])],
      excludes: [`${rel}/${SUPPLY_DIR}/**`, `${rel}/${REVIEW_DIR}/**`],
    }
  }
  return { targets: [dirs.dir], excludes: screenshots ? [] : [`${rel}/*/images/**`] }
}

const STORE = { ios: 'App Store', android: 'Google Play' } as const

function requireBundle(): void {
  if (!Bun.which('bundle')) {
    throw new KitError(
      'Missing tools for store metadata: bundle',
      'Run `kit doctor` (Ruby + Bundler)',
      ExitCode.precondition,
    )
  }
}

function storeId(config: KitConfig, platform: Platform): string {
  return platform === 'ios' ? config.release!.ios!.bundleIds[0]! : config.release!.android!.packageName
}

/** Credentials + lane inputs. Only the store API key: no signing, no keystore. */
function laneEnv(
  root: string,
  config: KitConfig,
  platform: Platform,
  dirs: MetadataDirs,
): Record<string, string> {
  const creds = platform === 'ios' ? appleCreds({ match: false, ci: onGitHubActions() }).env : playCreds()
  return {
    ...creds,
    ...laneConfigEnv(root, config),
    KIT_METADATA_PATH: dirs.dir,
    ...(dirs.screenshotsDir ? { KIT_SCREENSHOTS_PATH: dirs.screenshotsDir } : {}),
  }
}

type Ctx = Pick<KitContext, 'root' | 'config' | 'flags' | 'log'>

/**
 * The two switches of the listing lanes, always both and always explicit: a lane inherits kit's
 * environment, so one left unset would be read from the shell or a root `.env`.
 */
function partsEnv(text: boolean, screenshots: boolean): Record<string, string> {
  return { KIT_METADATA_TEXT: text ? '1' : '0', KIT_METADATA_SCREENSHOTS: screenshots ? '1' : '0' }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Download the current listing text into the metadata directory; screenshots and images only with
 * `screenshots`. Without it, local screenshots are neither written nor checked.
 */
export async function pullMetadata(
  ctx: Ctx,
  opts: { platform: Platform; force: boolean; screenshots: boolean },
): Promise<void> {
  const started = performance.now()
  const { root, config } = ctx as { root: string; config: KitConfig }
  const { platform, screenshots } = opts
  const flags = ctx.flags
  const dirs = metadataDirs(root, config, platform)
  const { targets, excludes } = pullScope(root, platform, dirs, screenshots)
  const shown = targets.map((t) => relative(root, t))
  const base = { platform, action: 'pull' as const, dir: shown[0]!, screenshots, screenshotsDir: shown[1] }

  if (!opts.force) {
    const dirty = await dirtyUnder(root, targets, excludes)
    if (dirty.length) {
      throw new KitError(
        `A pull would overwrite uncommitted changes in ${shown.join(' and ')}:\n${dirty
          .slice(0, 20)
          .map((l) => `    ${l}`)
          .join('\n')}`,
        'Commit or stash first, or pass --force',
        ExitCode.precondition,
      )
    }
  }
  if (flags.dryRun) {
    if (flags.json) emitJson({ ...base, dryRun: true })
    else {
      ctx.log.step(
        `would download the ${STORE[platform]} listing ${screenshots ? 'text and screenshots' : 'text'} of ${storeId(config, platform)} into ${shown.join(' and ')}`,
      )
    }
    return
  }
  requireBundle()
  const appRoot = appFastlaneDir(root, config)
  const env = { ...laneEnv(root, config, platform, dirs), ...partsEnv(true, screenshots) }
  let results: StepResult[]
  try {
    results = await runSteps(
      [laneStep(`pull ${STORE[platform]} listing`, appRoot, platform, 'metadata_pull', () => env)],
      flags,
      { bail: true },
    )
  } finally {
    // The lane removes it too; this also covers a lane that died halfway.
    if (platform === 'ios') rmSync(join(dirs.dir, REVIEW_DIR), { recursive: true, force: true })
  }
  const ok = results.length === 1 && results.every((r) => r.ok) && !interrupted()
  const { files } = pushPlan(root, platform, dirs, screenshots)
  if (flags.json) emitJson({ ...base, dryRun: false, ok, files, ...(ok ? {} : { results }) })
  process.exitCode = summarize(`metadata pull ${platform}`, results, started)
  if (ok && !flags.json) ctx.log.dim(`  ${plural(files.length, 'file')} in ${shown.join(' and ')}`)
}

/**
 * Upload listing text (and images with `screenshots`); `onlyScreenshots` sends the images and
 * leaves the store's text alone. Checks every image first, then confirms: it changes the public
 * listing. Never rewrites a repo file.
 */
export async function pushMetadata(
  ctx: Ctx,
  opts: { platform: Platform; screenshots: boolean; onlyScreenshots?: boolean },
): Promise<void> {
  const started = performance.now()
  const { root, config } = ctx as { root: string; config: KitConfig }
  const { platform } = opts
  const withText = opts.onlyScreenshots !== true
  const screenshots = opts.screenshots || !withText
  const flags = ctx.flags
  const dirs = metadataDirs(root, config, platform)
  const key = `release.${platform}.metadata`
  const shown = relative(root, dirs.dir)
  // iOS screenshots sit beside the metadata dir, so an image-only push can do without it.
  const needsDir = withText || platform === 'android'
  if (needsDir && (!existsSync(dirs.dir) || !statSync(dirs.dir).isDirectory())) {
    throw new KitError(
      `${key} points at ${shown}, which is not a directory`,
      `Fix ${key} in kit.config.ts, or fill it with \`kit release metadata pull ${platform}\``,
      ExitCode.usage,
    )
  }
  const { text } = pushPlan(root, platform, dirs, false, withText)
  if (withText && !text.length) {
    throw new KitError(
      `No listing text in ${shown}`,
      `Fill it with \`kit release metadata pull ${platform}\``,
      ExitCode.precondition,
    )
  }
  // One enumeration, the uploader's: the file list, the card, the JSON and the counts all read it.
  const preflight: ImagePreflight = screenshots
    ? checkListingImages(platform, root, dirs.screenshotsDir ?? dirs.dir)
    : { files: [], images: [], problems: [], warnings: [] }
  const { images, problems, warnings } = preflight
  const plan = { text, images: preflight.files, files: [...text, ...preflight.files] }
  // An image push replaces what the store has, so an empty set would clear the listing's screenshots.
  if (screenshots && !plan.images.length && !problems.length) {
    const where = dirs.screenshotsDir ? relative(root, dirs.screenshotsDir) : `${shown}/<locale>/images`
    throw new KitError(
      `${withText ? '--screenshots' : '--only-screenshots'}: no images in ${where}`,
      withText
        ? `Fill it with \`kit release metadata pull ${platform}\`, or drop --screenshots`
        : `Fill it with \`kit shots export\` or \`kit release metadata pull ${platform} --screenshots\``,
      ExitCode.precondition,
    )
  }
  const id = storeId(config, platform)
  const base = {
    platform,
    action: 'push' as const,
    dir: shown,
    screenshots,
    files: plan.files,
    images,
    problems,
    warnings,
  }
  // The store refuses these, and deliver has deleted the old screenshots by the time it finds out.
  if (problems.length) {
    if (flags.json) {
      emitJson({ ...base, dryRun: flags.dryRun === true, ok: false })
      process.exitCode = ExitCode.precondition
      return
    }
    throw new KitError(
      `${STORE[platform]} would refuse these images:\n${problems.map((p) => `    ${p}`).join('\n')}`,
      'Fix the files and push again: kit does not rewrite or move them',
      ExitCode.precondition,
    )
  }
  const what = [
    ...(withText ? [plural(plan.text.length, 'text file')] : []),
    ...(screenshots ? [plural(plan.images.length, 'image')] : []),
  ].join(' and ')
  // deliver deletes every screenshot set of a locale that has local files, whatever sets they fill.
  const replaced = platform === 'ios' ? imageLocales(images) : []
  const card = [
    ...imageSummary(images),
    ...(replaced.length ? [`replaces every screenshot set of: ${replaced.join(', ')}`] : []),
  ]

  if (flags.dryRun) {
    if (flags.json) emitJson({ ...base, dryRun: true })
    else {
      ctx.log.step(`would push ${what} to the ${STORE[platform]} listing of ${id}:`)
      for (const line of card) ctx.log.dim(`  ${line}`)
      for (const w of warnings) ctx.log.warn(w)
      process.stdout.write(`${plan.files.join('\n')}\n`)
    }
    return
  }
  requireBundle()
  const appRoot = appFastlaneDir(root, config)
  const env = { ...laneEnv(root, config, platform, dirs), ...partsEnv(withText, screenshots) }
  if (!flags.json) {
    process.stderr.write(
      `\n${pc.bold(`${config.name} ${platform} listing → ${STORE[platform]} (${id})`)}\n${pc.dim(plan.files.map((f) => `  ${f}`).join('\n'))}\n${card.map((l) => `  ${l}\n`).join('')}\n`,
    )
    for (const w of warnings) ctx.log.warn(w)
  }
  const ok = await confirm(flags, `Push ${what} to the public ${STORE[platform]} listing of ${id}?`)
  if (!ok) throw new KitError('Cancelled', undefined, ExitCode.interrupted)

  const results = await runSteps(
    [laneStep(`push ${STORE[platform]} listing`, appRoot, platform, 'metadata_push', () => env)],
    flags,
    { bail: true },
  )
  const pushed = results.length === 1 && results.every((r) => r.ok) && !interrupted()
  if (flags.json) emitJson({ ...base, dryRun: false, ok: pushed, ...(pushed ? {} : { results }) })
  process.exitCode = summarize(`metadata push ${platform}`, results, started)
}
