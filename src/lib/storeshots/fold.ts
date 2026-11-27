/**
 * Play's foldable screenshots (`shots.foldable`): the aspect ratios Play takes and the pixel size
 * kit draws each at. No imports, so the config schema can use it.
 */

/** Width to height. Play takes these seven for foldables. */
export const FOLD_ASPECTS = ['1:1', '4:3', '3:4', '16:10', '10:16', '16:9', '9:16'] as const
export type FoldAspect = (typeof FOLD_ASPECTS)[number]

/**
 * Play wants one unfolded 1:1, one unfolded 4:3 and one outer screen 10:16 at least. It asks
 * for 3 to 8 in all.
 */
export const PLAY_FOLD_REQUIRED: readonly FoldAspect[] = ['1:1', '4:3', '10:16']
export const PLAY_FOLD_MIN = 3
export const PLAY_FOLD_MAX = 8

/** The set id of an aspect, as `data-kit-set` and the export report name it: `fold-4x3`. */
export const foldSet = (aspect: FoldAspect): `fold-${string}` => `fold-${aspect.replace(':', 'x')}`

/**
 * Pixel size of each aspect: every side between Play's 960 and 3840, and a whole scale that
 * keeps the CSS viewport at least 500 wide.
 */
export const FOLD_SIZES: Record<FoldAspect, { width: number; height: number }> = {
  '1:1': { width: 2048, height: 2048 },
  '4:3': { width: 2560, height: 1920 },
  '3:4': { width: 1920, height: 2560 },
  '16:10': { width: 2560, height: 1600 },
  '10:16': { width: 1600, height: 2560 },
  '16:9': { width: 2560, height: 1440 },
  '9:16': { width: 1440, height: 2560 },
}

/** Play's screenshot type dir for foldables, beside `phoneScreenshots`. Not one supply uploads. */
export const PLAY_FOLD_DIR = 'foldableScreenshots'
