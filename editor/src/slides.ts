import type { DeviceTarget } from '../../src/lib/devices'
import { localizeSlide, resolveSlides } from '../../src/lib/storeshots/resolve'
import type { StudioSession, StudioShot, StudioShots } from '../../src/lib/storeshots/studio-api'
import type { Project, Slide } from '../../src/lib/storeshots/types'

/** The slides of `project` as drawn for `target` in `locale`, in export order. */
export function slidesFor(project: Project, target: DeviceTarget, locale: string): Slide[] {
  return resolveSlides(project, target).map((slide) => localizeSlide(project, slide, locale))
}

/**
 * The raw shot a slide draws on `target`: the locale dir's file when there is one, else the shared
 * one. The same lookup `planExport` makes.
 */
export function findShot(
  shots: StudioShots,
  target: DeviceTarget,
  slide: Pick<Slide, 'sourceFile'>,
  locale: string,
): StudioShot | undefined {
  const list = shots[target] ?? []
  return (
    list.find((shot) => shot.locale === locale && shot.file === slide.sourceFile) ??
    list.find((shot) => shot.locale === undefined && shot.file === slide.sourceFile)
  )
}

/** Where the file of a slide's shot is expected, for the empty state: `<raw>/<target>/<file>`. */
export const expectedShot = (
  session: StudioSession,
  target: DeviceTarget,
  slide: Pick<Slide, 'sourceFile'>,
) => `${session.rawPath.replace(/\/+$/, '')}/${target}/${slide.sourceFile}`

/** Width and height as one aspect, e.g. for fitting a canvas into a box. */
export const aspectOf = (size: { width: number; height: number }): number => size.width / size.height
