import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DeviceTarget } from '../devices'
import { ExitCode, KitError } from '../errors'
import { localizeSlide } from './project'
import { resolveSets, SET_SIZES, STORE_TARGETS, type Store } from './sizes'
import type {
  ExportPlan,
  Job,
  PageBrand,
  PageFont,
  PlanExport,
  SkippedSlide,
  Slide,
  SlideDevice,
  StoreDestination,
} from './types'

/** The frame that is the target's own device, and its screen corner in px of a 1320-wide canvas. */
export const TARGET_FRAME: Record<DeviceTarget, Pick<SlideDevice, 'frameType' | 'cornerRadius'>> = {
  ios: { frameType: 'iphone-pro', cornerRadius: 56 },
  ipad: { frameType: 'ipad-pro', cornerRadius: 24 },
  android: { frameType: 'android-pixel', cornerRadius: 48 },
}

const isTargetFrame = (frameType: SlideDevice['frameType']): boolean =>
  Object.values(TARGET_FRAME).some((frame) => frame.frameType === frameType)

/**
 * The slide as it is drawn for `target`. The layout is the slide's; only the raw shot, and the
 * frame when it was a target's own device, follow the target. A clay, glass or frameless choice
 * is deliberate and stays.
 */
export function slideForTarget(slide: Slide, target: DeviceTarget): Slide {
  if (slide.platform === target) return slide
  return {
    ...slide,
    platform: target,
    device: isTargetFrame(slide.device.frameType)
      ? { ...slide.device, ...TARGET_FRAME[target] }
      : slide.device,
  }
}

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

/** `/`-separated path of `file` relative to `root`; absolute when it is outside `root`. */
export function repoPath(root: string, file: string): string {
  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return file
  return rel.split('\\').join('/')
}

/** The PNG a job writes: see `Job.file`. */
function outputFile(destination: StoreDestination, locale: string, job: Pick<Job, 'set' | 'index'>, slug: string) {
  return destination.store === 'apple'
    ? join(destination.dir, locale, `${nn(job.index)}_${job.set}_${slug}.png`)
    : join(destination.dir, locale, 'images', 'phoneScreenshots', `${nn(job.index)}_${slug}.png`)
}

/** `shots.fonts` and `shots.brand` as the page loads them, with the files they point at. */
function pageAssets(
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
  // Array.prototype.sort is stable: slides with the same order keep their place in the file.
  const slides = [...project.slides].sort((a, b) => a.order - b.order)

  const jobs: Job[] = []
  const skipped: SkippedSlide[] = []
  const missing = new Set<string>()

  for (const destination of destinations) {
    const store: Store = destination.store
    for (const target of STORE_TARGETS[store]) {
      const set = sets[target]
      const { width, height } = SET_SIZES[set]
      for (const locale of destination.locales) {
        if (!LOCALE.test(locale)) {
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
            slide: slideForTarget(localizeSlide(project, slide, locale), target),
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
