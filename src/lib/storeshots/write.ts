import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { DeviceTarget } from '../devices'
import { ExitCode, KitError } from '../errors'
import { imageInfo } from '../image/png'
import { repoPath } from './plan'
import { APPLE_SET_CLASS, type AppleClass, appleClass, type SetId } from './sizes'
import {
  type Job,
  MANIFEST_FILE,
  type ShotsManifest,
  type StoreDestination,
  type WriteExport,
  type WrittenShot,
} from './types'

/**
 * Writing an export into the store dirs. Export owns one set at a time: on the App Store the
 * images of one display type in a `<locale>` dir, on Play a `<locale>/images/phoneScreenshots` dir.
 * Only sets that have a job in the plan are touched, and inside them only images: the manifest
 * says which are kit's to replace, and any other image there is in the way. Play's `icon`,
 * `featureGraphic` and its other screenshot types are never read, removed or written.
 */

const IMAGE = /\.(png|jpe?g)$/i
const PLAY_SET_DIR = ['images', 'phoneScreenshots'] as const

/** The target a set id is the export size of. */
const targetOfSet = (set: string): DeviceTarget | undefined =>
  set === 'phone'
    ? 'android'
    : set.startsWith('iphone-')
      ? 'ios'
      : set.startsWith('ipad-')
        ? 'ipad'
        : undefined

/** What one store's export does to its dir. Paths in the sets are relative to the dir, `/`-separated. */
interface DestinationChange {
  destination: StoreDestination
  jobs: Job[]
  /** Images removed: stale files of the manifest, and under `--force` the unlisted ones in the way. */
  remove: string[]
  /** Unlisted images in a set being written. */
  unowned: string[]
  /** The manifest after the export; undefined when the dir has none and nothing is written. */
  manifest?: ShotsManifest
  /** The manifest while the export runs: everything listed before and everything about to be written. */
  interim?: ShotsManifest
}

const manifestOf = (files: Iterable<string>): ShotsManifest => ({
  version: 1,
  files: [...new Set(files)].sort(),
})

/** A manifest entry kit may act on: a plain relative path that stays inside the dir. */
const isSafeEntry = (entry: string): boolean =>
  entry !== '' &&
  !entry.startsWith('/') &&
  !entry.includes('\\') &&
  entry.split('/').every((s) => s !== '' && s !== '.' && s !== '..')

/** The files the last export wrote in `dir`; none when there is no manifest. */
function readManifest(dir: string, force: boolean): string[] {
  const file = join(dir, MANIFEST_FILE)
  if (!existsSync(file)) return []
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<ShotsManifest>
    if (
      value.version !== 1 ||
      !Array.isArray(value.files) ||
      value.files.some((f) => typeof f !== 'string')
    ) {
      throw new Error('not a version 1 manifest')
    }
    return value.files.filter(isSafeEntry)
  } catch (e) {
    if (force) return []
    throw new KitError(
      `Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`,
      'It lists the screenshots kit shots export wrote. Restore it from git, or pass --force to treat every image in the exported sets as replaceable',
      ExitCode.precondition,
    )
  }
}

/** `statSync`, or undefined for an entry that cannot be read: a dangling symlink, a file gone since the listing. */
export function statOrSkip(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/** The image files directly in `dir` (no dot files, no sub-dirs, nothing that fails to stat), sorted. */
function imagesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(
      (name) => !name.startsWith('.') && IMAGE.test(name) && statOrSkip(join(dir, name))?.isFile() === true,
    )
    .sort()
}

/** The App Store display type of an image on disk, as deliver would file it; undefined when it has none. */
function classOnDisk(file: string): AppleClass | undefined {
  try {
    const info = imageInfo(new Uint8Array(readFileSync(file)))
    return appleClass(info.width, info.height, file)
  } catch {
    return undefined
  }
}

/** `<locale>/<NN>_<set>_<slug>.png`: the locale and set of an App Store file kit wrote. */
function appleEntry(entry: string): { locale: string; target?: DeviceTarget } | undefined {
  const parts = entry.split('/')
  if (parts.length !== 2) return undefined
  const set = /^\d+_([^_]+)_/.exec(parts[1]!)?.[1]
  return { locale: parts[0]!, target: set === undefined ? undefined : targetOfSet(set) }
}

/** `<locale>/images/phoneScreenshots/<file>`: the locale of a Play phone screenshot. */
function playEntry(entry: string): { locale: string } | undefined {
  const parts = entry.split('/')
  if (parts.length !== 4 || parts[1] !== PLAY_SET_DIR[0] || parts[2] !== PLAY_SET_DIR[1]) return undefined
  return { locale: parts[0]! }
}

/** Work out, without touching disk, what the export does to one store's dir. */
function changeFor(destination: StoreDestination, jobs: Job[], force: boolean): DestinationChange {
  const { dir, store } = destination
  const rel = (file: string) => relative(dir, file).split(sep).join('/')
  const listed = readManifest(dir, force)
  const hasManifest = existsSync(join(dir, MANIFEST_FILE))
  if (jobs.length === 0) {
    return {
      destination,
      jobs,
      remove: [],
      unowned: [],
      manifest: hasManifest ? manifestOf(listed) : undefined,
    }
  }

  const owned = new Set(listed)
  const writing = new Set(jobs.map((job) => rel(job.file)))
  // The sets this export owns: `<locale>` with the targets written there (apple), or `<locale>` (google).
  const sets = new Map<string, Set<DeviceTarget>>()
  for (const job of jobs) sets.set(job.locale, (sets.get(job.locale) ?? new Set()).add(job.target))

  const stale = listed.filter((entry) => {
    if (writing.has(entry) || !IMAGE.test(entry)) return false
    if (store === 'google') {
      const at = playEntry(entry)
      return at !== undefined && sets.has(at.locale)
    }
    const at = appleEntry(entry)
    return at?.target !== undefined && (sets.get(at.locale)?.has(at.target) ?? false)
  })

  const unowned: string[] = []
  for (const [locale, targets] of sets) {
    if (store === 'google') {
      for (const name of imagesIn(join(dir, locale, ...PLAY_SET_DIR))) {
        const entry = [locale, ...PLAY_SET_DIR, name].join('/')
        if (!owned.has(entry)) unowned.push(entry)
      }
      continue
    }
    const classes = new Set<AppleClass>(
      jobs
        .filter((job) => job.locale === locale && targets.has(job.target))
        .map((job) => APPLE_SET_CLASS[job.set as Exclude<SetId, 'phone'>]),
    )
    for (const name of imagesIn(join(dir, locale))) {
      const entry = `${locale}/${name}`
      if (owned.has(entry)) continue
      // In the way: an image of a display type being written (deliver files it in the same set),
      // or one sitting at a path this export writes.
      const cls = classOnDisk(join(dir, locale, name))
      if (writing.has(entry) || (cls !== undefined && classes.has(cls))) unowned.push(entry)
    }
  }

  const remove = [
    ...stale.filter((entry) => existsSync(join(dir, entry))),
    ...unowned.filter((e) => !writing.has(e)),
  ]
  const gone = new Set([...stale, ...unowned])
  return {
    destination,
    jobs,
    remove: [...new Set(remove)].sort(),
    unowned: unowned.sort(),
    manifest: manifestOf([...listed.filter((entry) => !gone.has(entry)), ...writing]),
    interim: manifestOf([...listed, ...writing]),
  }
}

/** Write `bytes` to `file` through a temp file in the same dir, so a reader never sees half of it. */
function writeAtomic(file: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  try {
    writeFileSync(tmp, bytes)
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

const writeManifest = (dir: string, manifest: ShotsManifest): void =>
  writeAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)

/**
 * Put a rendered export in the store dirs. Every set is checked before anything changes; then, per
 * store dir: the manifest first (so a file kit wrote is always listed, even if the run dies), the
 * PNGs, the removal of what the export replaces, and the final manifest. A dry run does the same
 * checks and reports the same result without writing or removing.
 */
export const writeExport: WriteExport = async (plan, opts) => {
  const { root, force, dryRun, images } = opts
  const changes = plan.destinations.map((destination) =>
    changeFor(
      destination,
      plan.jobs.filter((job) => job.store === destination.store),
      force,
    ),
  )

  const inTheWay = changes.flatMap((c) =>
    c.unowned.map((entry) => repoPath(root, join(c.destination.dir, entry))),
  )
  if (inTheWay.length > 0 && !force) {
    throw new KitError(
      `${inTheWay.length} image${inTheWay.length === 1 ? '' : 's'} kit shots export did not write ${inTheWay.length === 1 ? 'is' : 'are'} in the way:\n${inTheWay.map((f) => `  ${f}`).join('\n')}`,
      `Move ${inTheWay.length === 1 ? 'it' : 'them'} out of the exported sets, or pass --force to replace ${inTheWay.length === 1 ? 'it' : 'them'}`,
      ExitCode.precondition,
    )
  }

  const written: WrittenShot[] = plan.jobs.map((job) => ({
    store: job.store,
    target: job.target,
    set: job.set,
    locale: job.locale,
    slide: job.slide.id,
    file: repoPath(root, job.file),
    width: job.width,
    height: job.height,
  }))
  const removed = changes
    .flatMap((c) => c.remove.map((entry) => repoPath(root, join(c.destination.dir, entry))))
    .sort()
  if (dryRun) return { written, removed }

  const absent = plan.jobs.filter((job) => !images?.has(job.id)).map((job) => job.id)
  if (absent.length > 0) {
    throw new KitError(`No rendered image for ${absent.join(', ')}`, 'Nothing was written')
  }

  for (const change of changes) {
    const { dir } = change.destination
    if (change.jobs.length === 0 || !change.manifest || !change.interim) continue
    mkdirSync(dir, { recursive: true })
    writeManifest(dir, change.interim)
    for (const job of change.jobs) writeAtomic(job.file, images!.get(job.id)!)
    for (const entry of change.remove) rmSync(join(dir, entry), { force: true })
    writeManifest(dir, change.manifest)
  }
  return { written, removed }
}
