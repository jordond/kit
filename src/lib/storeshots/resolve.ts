import type { DeviceTarget } from '../devices'
import type {
  FullStyle,
  Project,
  ProjectV2,
  Slide,
  SlideBackground,
  SlideBadge,
  SlideDevice,
  SlideLocaleText,
  SlideText,
  SlideV2,
  StyleRules,
  TextRules,
} from './types'

/**
 * Expands a project into the full `Slide` the plan and the page draw. Pure, and free of Node and
 * Bun imports (type imports only): the browser editor imports this file too.
 */

/** The frame that is the target's own device, and its screen corner in px of a 1320-wide canvas. */
export const TARGET_FRAME: Record<DeviceTarget, Pick<SlideDevice, 'frameType' | 'cornerRadius'>> = {
  ios: { frameType: 'iphone-pro', cornerRadius: 56 },
  ipad: { frameType: 'ipad-pro', cornerRadius: 24 },
  android: { frameType: 'android-pixel', cornerRadius: 48 },
}

const isTargetFrame = (frameType: SlideDevice['frameType']): boolean =>
  Object.values(TARGET_FRAME).some((frame) => frame.frameType === frameType)

/** Screen corner of a frame that is not a target's own device, unless the rules set one. */
const OTHER_FRAME_CORNER = 56

/**
 * What a field is when no rule sets it: brewd's baseline slide (`generateDefaultSlides`) with
 * neutral colours and CSS-generic fonts. The frame type and corner radius are not here: they follow
 * the target (`TARGET_FRAME`).
 */
export const BUILT_IN_STYLE: FullStyle = {
  headline: {
    fontFamily: 'sans-serif',
    fontSize: 100,
    fontWeight: 800,
    color: '#111111',
    align: 'center',
    lineHeight: 1.12,
    shadow: false,
    shadowColor: 'rgba(0, 0, 0, 0.15)',
    shadowBlur: 10,
  },
  subheadline: {
    fontFamily: 'sans-serif',
    fontSize: 100,
    fontWeight: 600,
    color: '#555555',
    align: 'center',
    lineHeight: 1.3,
    shadow: false,
    shadowColor: 'rgba(0, 0, 0, 0.1)',
    shadowBlur: 8,
  },
  badge: {
    enabled: false,
    text: '',
    icon: 'star',
    backgroundColor: 'rgba(0, 0, 0, 0.06)',
    textColor: '#333333',
    borderColor: 'rgba(0, 0, 0, 0.15)',
    fontSize: 100,
  },
  device: {
    color: 'titanium-natural',
    position: 'bottom-peek',
    scale: 0.76,
    yOffset: 2,
    xOffset: 0,
    rotation: 0,
    perspectiveTilt: 0,
    shadowElevation: 'deep',
    shadowColor: 'rgba(0, 0, 0, 0.35)',
    showReflection: true,
  },
  background: {
    type: 'linear-gradient',
    primaryColor: '#ffffff',
    secondaryColor: '#eeeeee',
    accentColor: '#888888',
    angle: 180,
    pattern: 'none',
  },
  brand: { show: true, position: 'top-center' },
}

/** The style sections, in the order they are merged and written. */
export const STYLE_SECTIONS = ['headline', 'subheadline', 'badge', 'device', 'background', 'brand'] as const

/** The rules of `layers` in order, a later layer's field replacing an earlier one's; objects merge by field. */
export function mergeRules(...layers: (StyleRules | undefined)[]): StyleRules {
  const out: Record<string, Record<string, unknown>> = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const section of STYLE_SECTIONS) {
      const rules = layer[section] as Record<string, unknown> | undefined
      if (!rules) continue
      const into = out[section] ?? {}
      out[section] = into
      for (const [key, value] of Object.entries(rules)) if (value !== undefined) into[key] = value
    }
  }
  return out as StyleRules
}

/** The shot's name without its `NN-` prefix and extension: `01-you.png` is `you`. */
export function derivedId(shot: string): string {
  const stem = shot.replace(/\.[^./]*$/, '')
  return stem.replace(/^\d+[-_ .]+/, '') || stem
}

/** The slide's id: its own, else derived from its shot. */
export const slideId = (slide: Pick<SlideV2, 'id' | 'shot'>): string => slide.id ?? derivedId(slide.shot)

/** The slide as it is drawn for `target`: only the frame and the platform follow the target. */
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

function text(rules: Required<TextRules>, id: string, words: string): SlideText {
  const { fontFamily, fontSize, fontWeight, color, align, lineHeight, shadow, shadowColor, shadowBlur } =
    rules
  return {
    id,
    text: words,
    fontFamily,
    fontSize,
    fontWeight,
    color,
    align,
    lineHeight,
    letterSpacing: 0,
    yOffset: 0,
    shadow,
    shadowColor,
    shadowBlur,
  }
}

/** One version 2 slide for `target`: the rules merged in order, then the derivations. */
export function resolveSlideV2(
  project: ProjectV2,
  slide: SlideV2,
  target: DeviceTarget,
  position: number,
): Slide {
  const rules = mergeRules(
    BUILT_IN_STYLE,
    project.style,
    project.targets?.[target],
    slide.style,
    slide.targets?.[target],
  ) as FullStyle & { device: { frameType?: SlideDevice['frameType']; cornerRadius?: number } }
  const id = slideId(slide)

  const frame = rules.device.frameType
  const own = frame === undefined || isTargetFrame(frame)
  const device: SlideDevice = {
    ...rules.device,
    frameType: own ? TARGET_FRAME[target].frameType : frame,
    cornerRadius: rules.device.cornerRadius ?? (own ? TARGET_FRAME[target].cornerRadius : OTHER_FRAME_CORNER),
  }
  const background: SlideBackground = {
    ...rules.background,
    blur: 0,
    panoramaTotalSlides: project.slides.length,
    panoramaSlideIndex: position,
  }
  const badge: SlideBadge = { ...rules.badge, text: slide.badge ?? rules.badge.text }
  return {
    id,
    order: position,
    name: slide.name ?? id,
    sourceFile: slide.shot,
    platform: target,
    badge,
    headline: text(rules.headline, `h-${id}`, slide.headline),
    subheadline: text(rules.subheadline, `sub-${id}`, slide.subheadline ?? ''),
    device,
    background,
    showMascot: rules.brand.show,
    mascotPosition: rules.brand.position,
  }
}

/**
 * The slides of a project as drawn for `target`, in export order. A version 1 project's slides are
 * its own, sorted by `order` (stable: ties keep file order), with the frame following the target. A
 * version 2 project is expanded: built-in rules, `style`, `targets[target]`, the slide's `style`,
 * the slide's `targets[target]`; text and the derived fields are the slide's.
 */
export function resolveSlides(project: Project, target: DeviceTarget): Slide[] {
  if (project.version === 2) {
    return project.slides.map((slide, position) => resolveSlideV2(project, slide, target, position))
  }
  return [...project.slides].sort((a, b) => a.order - b.order).map((slide) => slideForTarget(slide, target))
}

/** The language of a locale code: `fr` of `fr-CA`, `fr_CA` and `fr`. */
const language = (locale: string): string => locale.split(/[-_]/)[0]!.toLowerCase()

/**
 * The text that replaces a slide's base text in `locale`. Each field is looked up on its own:
 * the exact code (`fr-CA`) first, then the entries of the same language (`fr`, `fr-FR`) in file
 * order; a field none of them sets is absent, which keeps the slide's base text.
 */
export function localeText(project: Pick<Project, 'locales'>, locale: string, id: string): SlideLocaleText {
  const locales = project.locales ?? {}
  const lang = language(locale)
  const chain = [
    locales[locale]?.[id],
    ...Object.entries(locales)
      .filter(([code]) => code !== locale && language(code) === lang)
      .map(([, slides]) => slides[id]),
  ]
  const out: SlideLocaleText = {}
  for (const field of ['headline', 'subheadline', 'badge'] as const) {
    const value = chain.find((entry) => entry?.[field] !== undefined)?.[field]
    if (value !== undefined) out[field] = value
  }
  return out
}

/** The slide with its headline, subheadline and badge text in `locale`; the same slide when nothing changes. */
export function localizeSlide(project: Pick<Project, 'locales'>, slide: Slide, locale: string): Slide {
  const t = localeText(project, locale, slide.id)
  if (t.headline === undefined && t.subheadline === undefined && t.badge === undefined) return slide
  return {
    ...slide,
    headline: t.headline === undefined ? slide.headline : { ...slide.headline, text: t.headline },
    subheadline:
      t.subheadline === undefined ? slide.subheadline : { ...slide.subheadline, text: t.subheadline },
    badge: t.badge === undefined ? slide.badge : { ...slide.badge, text: t.badge },
  }
}
