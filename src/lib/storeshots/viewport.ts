/**
 * The CSS viewport headless Chrome lays a page out in: the PNG's pixel size divided by the device
 * scale factor. Pure, so the config schema and the tests can use it.
 */

/**
 * The narrowest window Chrome makes, in CSS pixels. Asked for less (1440 px at scale 4 is 360),
 * it lays the page out 500 wide and the screenshot crops it.
 */
export const MIN_VIEWPORT_WIDTH = 500

/** The largest device scale factor kit uses; `shots.pages[].scale` stops here too. */
export const MAX_SCALE = 4

export interface Viewport {
  width: number
  height: number
}

/**
 * The device scale factor for a `width` x `height` PNG: the largest whole number up to `MAX_SCALE`
 * that divides both sides and leaves a viewport at least `MIN_VIEWPORT_WIDTH` wide. Undefined when
 * none does (a PNG narrower than 500 px).
 */
export function chooseScale(width: number, height: number): number | undefined {
  for (let scale = MAX_SCALE; scale >= 1; scale--) {
    if (width % scale === 0 && height % scale === 0 && width / scale >= MIN_VIEWPORT_WIDTH) return scale
  }
  return undefined
}

/**
 * Why a PNG `width` px wide cannot be shot at `scale`, with the fix; undefined when its viewport is
 * wide enough. `what` names it (`page store-phone`).
 */
export function narrowViewport(
  what: string,
  width: number,
  height: number,
  scale: number,
): string | undefined {
  if (width / scale >= MIN_VIEWPORT_WIDTH) return undefined
  const better = chooseScale(width, height)
  const fix = better === undefined ? `make it at least ${MIN_VIEWPORT_WIDTH} px wide` : `use scale ${better}`
  return `${what}: ${width} / ${scale} = ${width / scale} CSS px is narrower than headless Chrome's ${MIN_VIEWPORT_WIDTH} minimum; ${fix}`
}

/** The viewport a PNG of this size is laid out in at `scale`. */
export const viewportOf = (width: number, height: number, scale: number): Viewport => ({
  width: width / scale,
  height: height / scale,
})

/**
 * Why the viewport the page reported is not the one asked for, with what to do about it; undefined
 * when they match.
 */
export function viewportProblem(
  asked: Viewport,
  reported: Viewport,
): { message: string; hint: string } | undefined {
  if (asked.width === reported.width && asked.height === reported.height) return undefined
  const message = `was laid out at ${reported.width}x${reported.height} CSS px, not ${asked.width}x${asked.height}`
  const hint =
    asked.width < MIN_VIEWPORT_WIDTH
      ? `Chrome makes no window narrower than ${MIN_VIEWPORT_WIDTH} CSS px: use a smaller scale, so that width / scale is at least ${MIN_VIEWPORT_WIDTH}`
      : 'Chrome did not make the window it was asked for; the screenshot would crop or pad the layout'
  return { message, hint }
}
