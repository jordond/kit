import { existsSync, readdirSync, statSync } from 'node:fs'
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
import { runSteps, summarize } from '../steps'
import { appleCreds, onGitHubActions, playCreds } from './creds'
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

const IMAGE = /\.(png|jpe?g)$/i
/** supply's AVAILABLE_METADATA_FIELDS; `changelogs/` is left to `kit release android`. */
const PLAY_FIELDS = ['title', 'short_description', 'full_description', 'video']
/** supply's dir inside a shared `fastlane/metadata`; deliver skips it too. */
const SUPPLY_DIR = 'android'

export interface MetadataDirs {
  /** Absolute metadata directory (`release.<platform>.metadata`). */
  dir: string
  /** iOS only: deliver's screenshots directory, next to `dir`. */
  screenshotsDir?: string
}

export interface ListingFiles {
  /** Listing text files, absolute, sorted. */
  text: string[]
  /** Screenshots (and, on Play, the feature graphic and icons), absolute, sorted. */
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

const isImage = (f: string) => IMAGE.test(f)

/** The listing files on disk for a platform. */
export function listingFiles(platform: Platform, dirs: MetadataDirs): ListingFiles {
  if (platform === 'ios') {
    return {
      text: walk(
        dirs.dir,
        (f) => f.endsWith('.txt'),
        (e, depth) => depth === 0 && e === SUPPLY_DIR,
      ),
      images: dirs.screenshotsDir ? walk(dirs.screenshotsDir, isImage) : [],
    }
  }
  const text: string[] = []
  const images: string[] = []
  if (!existsSync(dirs.dir)) return { text, images }
  for (const locale of readdirSync(dirs.dir).sort()) {
    const base = join(dirs.dir, locale)
    if (locale.startsWith('.') || !statSync(base).isDirectory()) continue
    for (const field of PLAY_FIELDS) {
      const file = join(base, `${field}.txt`)
      if (existsSync(file)) text.push(file)
    }
    images.push(...walk(join(base, 'images'), isImage))
  }
  return { text, images }
}

/** What `push` sends: text always, images only with `--screenshots`. Paths relative to `root`. */
export function pushPlan(
  root: string,
  platform: Platform,
  dirs: MetadataDirs,
  screenshots: boolean,
): { text: string[]; images: string[]; files: string[] } {
  const found = listingFiles(platform, dirs)
  const rel = (p: string) => relative(root, p)
  const text = found.text.map(rel)
  const images = screenshots ? found.images.map(rel) : []
  return { text, images, files: [...text, ...images] }
}

/**
 * Uncommitted changes under `paths` (`git status --porcelain` lines): what a pull would overwrite
 * with no way back. Outside a git repo, every existing file counts.
 */
export async function dirtyUnder(root: string, paths: string[]): Promise<string[]> {
  const { code, stdout } = await runPiped(['git', 'status', '--porcelain', '--', ...paths], { cwd: root })
  if (code === 0) return stdout.split('\n').filter(Boolean)
  return paths.flatMap((p) => walk(p, () => true).map((f) => `?? ${relative(root, f)}`))
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Download the current listing (text and screenshots) into the metadata directory. */
export async function pullMetadata(ctx: Ctx, opts: { platform: Platform; force: boolean }): Promise<void> {
  const started = performance.now()
  const { root, config } = ctx as { root: string; config: KitConfig }
  const { platform } = opts
  const flags = ctx.flags
  const dirs = metadataDirs(root, config, platform)
  const targets = [dirs.dir, ...(dirs.screenshotsDir ? [dirs.screenshotsDir] : [])]
  const shown = targets.map((t) => relative(root, t))
  const base = { platform, action: 'pull' as const, dir: shown[0]!, screenshotsDir: shown[1] }

  if (!opts.force) {
    const dirty = await dirtyUnder(root, targets)
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
        `would download the ${STORE[platform]} listing of ${storeId(config, platform)} into ${shown.join(' and ')}`,
      )
    }
    return
  }
  requireBundle()
  const appRoot = appFastlaneDir(root, config)
  const env = laneEnv(root, config, platform, dirs)
  const results = await runSteps(
    [laneStep(`pull ${STORE[platform]} listing`, appRoot, platform, 'metadata_pull', () => env)],
    flags,
    { bail: true },
  )
  const ok = results.length === 1 && results.every((r) => r.ok) && !interrupted()
  const found = listingFiles(platform, dirs)
  const files = [...found.text, ...found.images].map((f) => relative(root, f))
  if (flags.json) emitJson({ ...base, dryRun: false, ok, files, ...(ok ? {} : { results }) })
  process.exitCode = summarize(`metadata pull ${platform}`, results, started)
  if (ok && !flags.json) ctx.log.dim(`  ${plural(files.length, 'file')} in ${shown.join(' and ')}`)
}

/** Upload listing text (and images with `screenshots`). Confirms: it changes the public listing. */
export async function pushMetadata(
  ctx: Ctx,
  opts: { platform: Platform; screenshots: boolean },
): Promise<void> {
  const started = performance.now()
  const { root, config } = ctx as { root: string; config: KitConfig }
  const { platform, screenshots } = opts
  const flags = ctx.flags
  const dirs = metadataDirs(root, config, platform)
  const key = `release.${platform}.metadata`
  const shown = relative(root, dirs.dir)
  if (!existsSync(dirs.dir) || !statSync(dirs.dir).isDirectory()) {
    throw new KitError(
      `${key} points at ${shown}, which is not a directory`,
      `Fix ${key} in kit.config.ts, or fill it with \`kit release metadata pull ${platform}\``,
      ExitCode.usage,
    )
  }
  const plan = pushPlan(root, platform, dirs, screenshots)
  if (!plan.text.length) {
    throw new KitError(
      `No listing text in ${shown}`,
      `Fill it with \`kit release metadata pull ${platform}\``,
      ExitCode.precondition,
    )
  }
  // An image push replaces what the store has, so an empty set would clear the listing's screenshots.
  if (screenshots && !plan.images.length) {
    const where = dirs.screenshotsDir ? relative(root, dirs.screenshotsDir) : `${shown}/<locale>/images`
    throw new KitError(
      `--screenshots: no images in ${where}`,
      `Fill it with \`kit release metadata pull ${platform}\`, or drop --screenshots`,
      ExitCode.precondition,
    )
  }
  const id = storeId(config, platform)
  const base = { platform, action: 'push' as const, dir: shown, screenshots, files: plan.files }
  const what = `${plural(plan.text.length, 'text file')}${screenshots ? ` and ${plural(plan.images.length, 'image')}` : ''}`

  if (flags.dryRun) {
    if (flags.json) emitJson({ ...base, dryRun: true })
    else {
      ctx.log.step(`would push ${what} to the ${STORE[platform]} listing of ${id}:`)
      process.stdout.write(`${plan.files.join('\n')}\n`)
    }
    return
  }
  requireBundle()
  const appRoot = appFastlaneDir(root, config)
  const env = {
    ...laneEnv(root, config, platform, dirs),
    ...(screenshots ? { KIT_METADATA_SCREENSHOTS: '1' } : {}),
  }
  if (!flags.json) {
    process.stderr.write(
      `\n${pc.bold(`${config.name} ${platform} listing → ${STORE[platform]} (${id})`)}\n${pc.dim(plan.files.map((f) => `  ${f}`).join('\n'))}\n\n`,
    )
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
