import { isAbsolute, join, relative, resolve } from 'node:path'
import { ExitCode, KitError } from '../errors'
import { localizeSlide, resolveSlides } from './resolve'
import { resolveSets, SET_SIZES, STORE_TARGETS, type Store } from './sizes'
import type {
  ExportPlan,
  Job,
  PageBrand,
  PageFont,
  PlanExport,
  SkippedSlide,
  Slide,
  StoreDestination,
} from './types'

export { slideForTarget, TARGET_FRAME } from './resolve'

/**
 * The `<slug>` of an exported file name: the slide name lower-cased, every run of characters
 * outside `[a-z0-9]` turned into one `-`, trimmed of `-`; the slide id, slugged the same way,
 * when that leaves nothing.
 */
export function slideSlug(slide: Pick<Slide, 'id' | 'name'>): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  return slug(slide.name) || slug(slide.id) || 'slide'
}

/** `NN`: a 1-based position zero-padded to two digits. */
const nn = (index: number): string => String(index).padStart(2, '0')

/** A locale is one dir name and one piece of a job id, so it has to be safe as both. */
const LOCALE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Whether `name` can be a locale: what a `--locale` has to be, and what a metadata dir has to be named to count as one. */
export const isLocale = (name: string): boolean => LOCALE.test(name)

/** `/`-separated path of `file` relative to `root`; absolute when it is outside `root`. */
export function repoPath(root: string, file: string): string {
  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return file
  return rel.split('\\').join('/')
}

/** The PNG a job writes: see `Job.file`. */
function outputFile(
  destination: StoreDestination,
  locale: string,
  job: Pick<Job, 'set' | 'index'>,
  slug: string,
) {
  return destination.store === 'apple'
    ? join(destination.dir, locale, `${nn(job.index)}_${job.set}_${slug}.png`)
    : join(destination.dir, locale, 'images', 'phoneScreenshots', `${nn(job.index)}_${slug}.png`)
}

/** `shots.fonts` and `shots.brand` as the page loads them, with the files they point at. */
export function pageAssets(
  root: string,
  shots: NonNullable<Parameters<PlanExport>[0]['config']['shots']>,
): Pick<ExportPlan, 'fonts' | 'brand' | 'assets'> {
  const assets: string[] = []
  const asset = (file: string): string => `asset/${assets.push(resolve(root, file)) - 1}`
  const fonts: PageFont[] = (shots.fonts ?? []).map((font) => ({
    family: font.family,
    url: asset(font.file),
    ...(font.weight === undefined ? {} : { weight: font.weight }),
  }))
  if (!shots.brand) return { fonts, assets }
  const { mark, wordmark, color, font } = shots.brand
  const brand: PageBrand = {
    mark: asset(mark),
    ...(wordmark === undefined ? {} : { wordmark }),
    ...(color === undefined ? {} : { color }),
    ...(font === undefined ? {} : { font }),
  }
  return { fonts, brand, assets }
}

/**
 * Plan one `kit shots export`: every slide of the project, in `order`, for each set of each
 * exported store and each of its locales. Pure: the raw listing and the destinations are passed in.
 */
export const planExport: PlanExport = (input) => {
  const { root, config, project, destinations, rawDir, raw, allowMissing } = input
  if (!config.shots) {
    throw new KitError(
      'No shots block in kit.config.ts',
      "Add shots: { project: '<saved project>.json' } to kit.config.ts",
      ExitCode.config,
    )
  }
  const sets = resolveSets(config)

  const jobs: Job[] = []
  const skipped: SkippedSlide[] = []
  const missing = new Set<string>()

  for (const destination of destinations) {
    const store: Store = destination.store
    for (const target of STORE_TARGETS[store]) {
      const set = sets[target]
      const { width, height } = SET_SIZES[set]
      // Version 1 slides sort by `order` (stable: ties keep their place in the file).
      const slides = resolveSlides(project, target)
      for (const locale of destination.locales) {
        if (!isLocale(locale)) {
          throw new KitError(
            `"${locale}" is not a locale kit can export`,
            'A locale is a store locale code such as en-US: letters, digits, ".", "_" and "-"',
            ExitCode.usage,
          )
        }
        let index = 0
        for (const slide of slides) {
          const localised = `${target}/${locale}/${slide.sourceFile}`
          const shared = `${target}/${slide.sourceFile}`
          const found = raw.has(localised) ? localised : raw.has(shared) ? shared : undefined
          if (found === undefined) {
            const shot = repoPath(root, join(rawDir, target, slide.sourceFile))
            missing.add(shot)
            skipped.push({ store, target, set, locale, slide: slide.id, shot })
            continue
          }
          index += 1
          const job = { set, index }
          jobs.push({
            id: `${target}-${locale}-${nn(index)}`,
            store,
            target,
            set,
            locale,
            index,
            width,
            height,
            slide: localizeSlide(project, slide, locale),
            shot: join(rawDir, ...found.split('/')),
            file: outputFile(destination, locale, job, slideSlug(slide)),
          })
        }
      }
    }
  }

  if (missing.size > 0 && !allowMissing) {
    const files = [...missing]
    const targets = [...new Set(skipped.map((s) => s.target))]
    throw new KitError(
      `${files.length} raw shot${files.length === 1 ? ' is' : 's are'} missing:\n${files.map((f) => `  ${f}`).join('\n')}`,
      `Take ${files.length === 1 ? 'it' : 'them'} with ${targets.map((t) => `\`kit shots ${t}\``).join(', ')}, or pass --allow-missing to export without ${files.length === 1 ? 'that slide' : 'those slides'}`,
      ExitCode.precondition,
    )
  }

  return {
    stores: destinations.map((d) => d.store),
    destinations: [...destinations],
    jobs,
    skipped,
    ...pageAssets(root, config.shots),
  }
}
