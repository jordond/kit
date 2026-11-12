import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import type { LoadProject, Slide, SlideLocaleText, StudioProject } from './types'

/**
 * The saved project of `kit shots export`: brewd's `studio.json` version 1, read as is, plus the
 * optional `locales` block. Every object is loose: a key the editor adds later is kept, not refused.
 */

const target = z.enum(['ios', 'ipad', 'android'])

const text = z.looseObject({
  id: z.string(),
  text: z.string(),
  fontFamily: z.string(),
  fontSize: z.number(),
  fontWeight: z.number(),
  color: z.string(),
  align: z.enum(['left', 'center', 'right']),
  lineHeight: z.number(),
  letterSpacing: z.number(),
  yOffset: z.number(),
  shadow: z.boolean(),
  shadowColor: z.string(),
  shadowBlur: z.number(),
})

const badge = z.looseObject({
  enabled: z.boolean(),
  text: z.string(),
  icon: z.enum(['cup', 'star', 'sparkles', 'map', 'heart', 'check', 'none']),
  backgroundColor: z.string(),
  textColor: z.string(),
  borderColor: z.string(),
  fontSize: z.number(),
})

const device = z.looseObject({
  frameType: z.enum(['iphone-pro', 'ipad-pro', 'android-pixel', 'clay-minimal', 'frameless', 'glass-card']),
  color: z.enum([
    'titanium-natural',
    'titanium-black',
    'titanium-desert',
    'titanium-silver',
    'espresso',
    'cream',
  ]),
  position: z.enum(['bottom-peek', 'center-float', 'top-peek', 'angled-3d', 'full-bleed']),
  scale: z.number(),
  yOffset: z.number(),
  xOffset: z.number(),
  rotation: z.number(),
  perspectiveTilt: z.number(),
  shadowElevation: z.enum(['none', 'subtle', 'medium', 'deep', 'dramatic']),
  shadowColor: z.string(),
  showReflection: z.boolean(),
  cornerRadius: z.number(),
})

const background = z.looseObject({
  type: z.enum(['solid', 'linear-gradient', 'radial-gradient', 'mesh-glow', 'panorama']),
  primaryColor: z.string(),
  secondaryColor: z.string(),
  accentColor: z.string(),
  angle: z.number(),
  blur: z.number(),
  pattern: z.enum(['none', 'coffee-beans', 'warm-glow', 'subtle-grid', 'rings']),
  panoramaTotalSlides: z.number().optional(),
  panoramaSlideIndex: z.number().optional(),
})

const slide = z.looseObject({
  id: z.string().min(1),
  order: z.number(),
  name: z.string(),
  imageSrc: z.string().optional(),
  sourceFile: z.string().min(1),
  platform: target,
  badge,
  headline: text,
  subheadline: text,
  device,
  background,
  showMascot: z.boolean(),
  mascotPosition: z.enum(['top-center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']),
  customNotes: z.string().optional(),
})

const localeTextSchema = z
  .object({
    headline: z.string().optional(),
    subheadline: z.string().optional(),
    badge: z.string().optional(),
  })
  .strict()

/** The project file. `locales` is strict: a misspelt field there would silently export base text. */
export const projectSchema = z
  .looseObject({
    version: z.literal(1),
    platform: target,
    dimensionId: z.string().optional(),
    slides: z.array(slide),
    savedAt: z.string().optional(),
    locales: z.record(z.string(), z.record(z.string(), localeTextSchema)).optional(),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>()
    p.slides.forEach((s, i) => {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: 'custom', path: ['slides', i, 'id'], message: `Duplicate slide id "${s.id}"` })
      }
      seen.add(s.id)
    })
    for (const [locale, slides] of Object.entries(p.locales ?? {})) {
      for (const id of Object.keys(slides)) {
        if (!seen.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['locales', locale, id],
            message: `No slide has the id "${id}"`,
          })
        }
      }
    }
  })

/** A parsed value as a project, or a KitError (exit 3) naming every bad field by its path. */
export function parseProject(value: unknown, label = 'project'): StudioProject {
  const result = projectSchema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new KitError(
      `Invalid ${label}:\n${issues}`,
      'kit shots export reads a version 1 project: the JSON the screenshot editor saves',
      ExitCode.config,
    )
  }
  return result.data as StudioProject
}

/** Read and validate the saved project (`shots.project`). `file` is absolute. */
export const loadProject: LoadProject = async (file) => {
  if (!existsSync(file)) {
    throw new KitError(
      `No project file at ${file}`,
      'Set shots.project in kit.config.ts to the saved project JSON, relative to the repo root',
      ExitCode.config,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new KitError(
      `Invalid ${file}:\n  (root): not JSON (${e instanceof Error ? e.message : String(e)})`,
      'kit shots export reads a version 1 project: the JSON the screenshot editor saves',
      ExitCode.config,
    )
  }
  return parseProject(value, file)
}

/** The language of a locale code: `fr` of `fr-CA`, `fr_CA` and `fr`. */
const language = (locale: string): string => locale.split(/[-_]/)[0]!.toLowerCase()

/**
 * The text that replaces a slide's base text in `locale`. Each field is looked up on its own:
 * the exact code (`fr-CA`) first, then the entries of the same language (`fr`, `fr-FR`) in file
 * order; a field none of them sets is absent, which keeps the slide's base text.
 */
export function localeText(project: StudioProject, locale: string, slideId: string): SlideLocaleText {
  const locales = project.locales ?? {}
  const lang = language(locale)
  const chain = [
    locales[locale]?.[slideId],
    ...Object.entries(locales)
      .filter(([code]) => code !== locale && language(code) === lang)
      .map(([, slides]) => slides[slideId]),
  ]
  const out: SlideLocaleText = {}
  for (const field of ['headline', 'subheadline', 'badge'] as const) {
    const value = chain.find((entry) => entry?.[field] !== undefined)?.[field]
    if (value !== undefined) out[field] = value
  }
  return out
}

/** The slide with its headline, subheadline and badge text in `locale`; the same slide when nothing changes. */
export function localizeSlide(project: StudioProject, slide: Slide, locale: string): Slide {
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
