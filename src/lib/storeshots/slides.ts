import { extname, join, resolve } from 'node:path'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import type { ShootJob } from './pages'
import { isLocale, repoPath, slideSlug } from './plan'
import { resolveSets, SET_SIZES, STORE_TARGETS } from './sizes'
import type { SkippedSlide, StoreDestination, WriteJob } from './types'
import { chooseScale } from './viewport'

/**
 * HTML slides (`shots.slides`) in `kit shots export`: every slide, in config order, for each set
 * of each exported store and each of its locales. The page is shot like a `shots.pages` page and
 * written like a project slide, under the same file names.
 */

type Shots = NonNullable<KitConfig['shots']>

const DEFAULT_BACKGROUND = '#ffffff'

/** One HTML slide to shoot and write: a `WriteJob` for `writeExport`, a `ShootJob` for `shootPages`. */
export type SlideJob = WriteJob & ShootJob & { slide: { id: string; name: string } }

export interface SlidePlan {
  destinations: StoreDestination[]
  jobs: SlideJob[]
  skipped: SkippedSlide[]
}

export interface SlidePlanInput {
  /** Absolute repo root. */
  root: string
  /** Read for `shots.slides` and `shots.sets`. */
  config: Pick<KitConfig, 'shots'>
  destinations: StoreDestination[]
  /** Absolute raw dir; undefined when no slide names a shot. */
  rawDir: string | undefined
  /** The files under `rawDir`, `/`-separated and relative to it. */
  raw: ReadonlySet<string>
  allowMissing: boolean
}

/** The raw file a slide's `shot` names: `.png` is added to a name without an extension. */
export const shotFile = (shot: string): string => (extname(shot) === '' ? `${shot}.png` : shot)

const nn = (index: number): string => String(index).padStart(2, '0')

/**
 * Plan the HTML slides of one export. Pure: the raw listing and the destinations are passed in.
 * A slide whose raw shot is absent for a target is missing there (exit 4), or skipped under
 * `allowMissing`; the slides after it move up, as project slides do.
 */
export function planSlides(input: SlidePlanInput): SlidePlan {
  const { root, config, destinations, rawDir, raw, allowMissing } = input
  const slides: NonNullable<Shots['slides']> = config.shots?.slides ?? []
  const sets = resolveSets(config)
  const jobs: SlideJob[] = []
  const skipped: SkippedSlide[] = []
  const missing = new Set<string>()

  for (const destination of destinations) {
    const { store } = destination
    for (const target of STORE_TARGETS[store]) {
      const set = sets[target]
      const { width, height } = SET_SIZES[set]
      const scale = chooseScale(width, height)
      if (scale === undefined) throw new KitError(`No scale fits the ${set} set (${width}x${height})`)
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
          let shot: string | undefined
          if (slide.shot !== undefined) {
            const file = shotFile(slide.shot)
            const localised = `${target}/${locale}/${file}`
            const shared = `${target}/${file}`
            const found = raw.has(localised) ? localised : raw.has(shared) ? shared : undefined
            if (found === undefined || rawDir === undefined) {
              const looked = rawDir === undefined ? shared : repoPath(root, join(rawDir, target, file))
              missing.add(looked)
              skipped.push({ store, target, set, locale, slide: slide.name, shot: looked })
              continue
            }
            shot = join(rawDir, ...found.split('/'))
          }
          index += 1
          const name = `${nn(index)}_${store === 'apple' ? `${set}_` : ''}${slideSlug({ id: slide.name, name: slide.name })}.png`
          jobs.push({
            id: `${target}-${locale}-${nn(index)}`,
            store,
            target,
            set,
            locale,
            index,
            width,
            height,
            slide: { id: slide.name, name: slide.name },
            file:
              store === 'apple'
                ? join(destination.dir, locale, name)
                : join(destination.dir, locale, 'images', 'phoneScreenshots', name),
            name: slide.name,
            label: `slide ${slide.name} (${set}, ${locale})`,
            source: resolve(root, slide.file),
            scale,
            background: slide.background ?? DEFAULT_BACKGROUND,
            context: { set, target, store, locale, slide: slide.name, index, ...(shot ? { shot } : {}) },
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
  return { destinations: [...destinations], jobs, skipped }
}
