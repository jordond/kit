import type { DeviceTarget } from '../devices'
import type {
  BackgroundPattern,
  BackgroundType,
  BadgeIcon,
  DevicePosition,
  FrameColor,
  FrameType,
  MascotPosition,
  ShadowElevation,
  SlideLocaleText,
} from './types'

/**
 * The version 2 project file: the repo's screenshot rules once (`style`), per-target adjustments
 * (`targets`), and per slide only what is its own (`slides`). `resolveSlides` expands it into the
 * full `Slide` of version 1 for each target, so the plan, the page and the writer never see it.
 *
 * Every object is strict in version 2: a key that is not here is an error with its path.
 */

/** The fields of a text block a rule can set; its words come from the slide. */
export interface TextRules {
  fontFamily?: string
  /** Percent of the base size (100 is the default). */
  fontSize?: number
  fontWeight?: number
  color?: string
  align?: 'left' | 'center' | 'right'
  lineHeight?: number
  shadow?: boolean
  shadowColor?: string
  shadowBlur?: number
}

export interface BadgeRules {
  enabled?: boolean
  /** The text for every slide that sets no `badge` of its own. */
  text?: string
  icon?: BadgeIcon
  backgroundColor?: string
  textColor?: string
  borderColor?: string
  fontSize?: number
}

export interface DeviceRules {
  /** A platform frame follows the target; set a clay, glass or frameless frame to keep it. */
  frameType?: FrameType
  color?: FrameColor
  /** `angled-3d` is not in version 2: the renderer never had a branch for it. */
  position?: Exclude<DevicePosition, 'angled-3d'>
  scale?: number
  /** Percent of the canvas height. */
  yOffset?: number
  /** Percent of the canvas width. */
  xOffset?: number
  rotation?: number
  perspectiveTilt?: number
  shadowElevation?: ShadowElevation
  shadowColor?: string
  showReflection?: boolean
  /** Px of a 1320-wide canvas; absent, a platform frame's own and 56 for the others. */
  cornerRadius?: number
}

export interface BackgroundRules {
  type?: BackgroundType
  primaryColor?: string
  secondaryColor?: string
  accentColor?: string
  angle?: number
  pattern?: BackgroundPattern
}

/** The brand lockup (`shots.brand`); replaces version 1's `showMascot` and `mascotPosition`. */
export interface BrandRules {
  show?: boolean
  position?: MascotPosition
}

/** A set of rules; every key optional. The top-level `style`, a `targets` value and a slide's `style`. */
export interface StyleRules {
  headline?: TextRules
  subheadline?: TextRules
  badge?: BadgeRules
  device?: DeviceRules
  background?: BackgroundRules
  brand?: BrandRules
}

/** `StyleRules` with every field set: the built-in baseline. */
export interface FullStyle {
  headline: Required<TextRules>
  subheadline: Required<TextRules>
  badge: Required<BadgeRules>
  device: Required<Omit<DeviceRules, 'frameType' | 'cornerRadius'>> &
    Pick<DeviceRules, 'frameType' | 'cornerRadius'>
  background: Required<BackgroundRules>
  brand: Required<BrandRules>
}

/** One slide of a version 2 project. */
export interface SlideV2 {
  /** File name of the raw shot (`01-you.png`), looked up under the raw dir. */
  shot: string
  /** Absent, the shot's name without its `NN-` prefix and extension. Unique; the key into `locales`. */
  id?: string
  /** The `<slug>` of the exported file name; absent, the id. */
  name?: string
  headline: string
  subheadline?: string
  /** The badge text; whether it shows is `style.badge.enabled`. */
  badge?: string
  style?: StyleRules
  /** Rules for this slide on one target only, after the project's `targets`. */
  targets?: Partial<Record<DeviceTarget, StyleRules>>
}

/** The saved project, version 2. */
export interface ProjectV2 {
  version: 2
  style?: StyleRules
  targets?: Partial<Record<DeviceTarget, StyleRules>>
  slides: SlideV2[]
  /** As in version 1: locale code, then slide id. */
  locales?: Record<string, Record<string, SlideLocaleText>>
}
