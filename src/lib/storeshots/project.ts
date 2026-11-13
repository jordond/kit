import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import { slideId } from './resolve'
import {
  BACKGROUND_PATTERNS,
  BACKGROUND_TYPES,
  BADGE_ICONS,
  DEVICE_POSITIONS,
  FRAME_COLORS,
  FRAME_TYPES,
  type LoadProject,
  MASCOT_POSITIONS,
  type Project,
  SHADOW_ELEVATIONS,
} from './types'

/**
 * The saved project of `kit shots export`. Version 1 is brewd's `studio.json` read as is, plus the
 * optional `locales` block; every object is loose, a key the editor adds later is kept, not refused.
 * Version 2 (`types-v2.ts`) is the rules once plus sparse slides; every object is strict, a key it
 * does not know is an error with its path.
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
  icon: z.enum(BADGE_ICONS),
  backgroundColor: z.string(),
  textColor: z.string(),
  borderColor: z.string(),
  fontSize: z.number(),
})

const device = z.looseObject({
  frameType: z.enum(FRAME_TYPES),
  color: z.enum(FRAME_COLORS),
  position: z.enum(DEVICE_POSITIONS),
  scale: z.number(),
  yOffset: z.number(),
  xOffset: z.number(),
  rotation: z.number(),
  perspectiveTilt: z.number(),
  shadowElevation: z.enum(SHADOW_ELEVATIONS),
  shadowColor: z.string(),
  showReflection: z.boolean(),
  cornerRadius: z.number(),
})

const background = z.looseObject({
  type: z.enum(BACKGROUND_TYPES),
  primaryColor: z.string(),
  secondaryColor: z.string(),
  accentColor: z.string(),
  angle: z.number(),
  blur: z.number(),
  pattern: z.enum(BACKGROUND_PATTERNS),
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
  mascotPosition: z.enum(MASCOT_POSITIONS),
  customNotes: z.string().optional(),
})

const localeTextSchema = z
  .object({
    headline: z.string().optional(),
    subheadline: z.string().optional(),
    badge: z.string().optional(),
  })
  .strict()

const locales = z.record(z.string(), z.record(z.string(), localeTextSchema))

/** Slide ids are unique, and every `locales` entry names a slide that exists. */
function checkIds(
  ids: string[],
  locales: Record<string, Record<string, unknown>> | undefined,
  ctx: z.RefinementCtx,
  at: (index: number) => (string | number)[],
): void {
  const seen = new Set<string>()
  ids.forEach((id, i) => {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: at(i), message: `Duplicate slide id "${id}"` })
    seen.add(id)
  })
  for (const [locale, slides] of Object.entries(locales ?? {})) {
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
}

/** A version 1 project. `locales` is strict: a misspelt field there would silently export base text. */
const projectV1Schema = z
  .looseObject({
    version: z.literal(1),
    platform: target,
    dimensionId: z.string().optional(),
    slides: z.array(slide),
    savedAt: z.string().optional(),
    locales: locales.optional(),
  })
  .superRefine((p, ctx) =>
    checkIds(
      p.slides.map((s) => s.id),
      p.locales,
      ctx,
      (i) => ['slides', i, 'id'],
    ),
  )

// Version 2. Every rule is optional; a value has the type of the version 1 field it replaces.

const textRules = z
  .strictObject({
    fontFamily: z.string(),
    fontSize: z.number(),
    fontWeight: z.number(),
    color: z.string(),
    align: z.enum(['left', 'center', 'right']),
    lineHeight: z.number(),
    shadow: z.boolean(),
    shadowColor: z.string(),
    shadowBlur: z.number(),
  })
  .partial()

const badgeRules = z
  .strictObject({
    enabled: z.boolean(),
    text: z.string(),
    icon: badge.shape.icon,
    backgroundColor: z.string(),
    textColor: z.string(),
    borderColor: z.string(),
    fontSize: z.number(),
  })
  .partial()

const deviceRules = z
  .strictObject({
    frameType: device.shape.frameType,
    color: device.shape.color,
    position: z.enum(['bottom-peek', 'center-float', 'top-peek', 'full-bleed']),
    scale: z.number(),
    yOffset: z.number(),
    xOffset: z.number(),
    rotation: z.number(),
    perspectiveTilt: z.number(),
    shadowElevation: device.shape.shadowElevation,
    shadowColor: z.string(),
    showReflection: z.boolean(),
    cornerRadius: z.number(),
  })
  .partial()

const backgroundRules = z
  .strictObject({
    type: background.shape.type,
    primaryColor: z.string(),
    secondaryColor: z.string(),
    accentColor: z.string(),
    angle: z.number(),
    pattern: background.shape.pattern,
  })
  .partial()

const brandRules = z
  .strictObject({
    show: z.boolean(),
    position: slide.shape.mascotPosition,
  })
  .partial()

/** A set of style rules, every object strict. The project's `style`, and a preset in `shots.presets`. */
export const styleRules = z.strictObject({
  headline: textRules.optional(),
  subheadline: textRules.optional(),
  badge: badgeRules.optional(),
  device: deviceRules.optional(),
  background: backgroundRules.optional(),
  brand: brandRules.optional(),
})

const targetRules = z.strictObject({
  ios: styleRules.optional(),
  ipad: styleRules.optional(),
  android: styleRules.optional(),
})

const slideV2 = z.strictObject({
  shot: z.string().min(1),
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  headline: z.string(),
  subheadline: z.string().optional(),
  badge: z.string().optional(),
  style: styleRules.optional(),
  targets: targetRules.optional(),
})

/** A version 2 project: ids (own or derived) are unique, and `locales` names only slides that exist. */
const projectV2Schema = z
  .strictObject({
    version: z.literal(2),
    style: styleRules.optional(),
    targets: targetRules.optional(),
    slides: z.array(slideV2),
    locales: locales.optional(),
  })
  .superRefine((p, ctx) => checkIds(p.slides.map(slideId), p.locales, ctx, (i) => ['slides', i, 'id']))

/** The project file: a union on `version`. */
export const projectSchema = z.discriminatedUnion('version', [projectV1Schema, projectV2Schema])

const PROJECT_HINT =
  'kit shots export reads a version 1 project (the JSON the screenshot editor saves) or a version 2 project (`kit shots migrate` writes one)'

/** A parsed value as a project, or a KitError (exit 3) naming every bad field by its path. */
export function parseProject(value: unknown, label = 'project'): Project {
  const result = projectSchema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new KitError(`Invalid ${label}:\n${issues}`, PROJECT_HINT, ExitCode.config)
  }
  return result.data as Project
}

/** `shots.project`, or a config error naming it when only `shots.pages` is set. */
export function requireProjectPath(shots: { project?: string | undefined }): string {
  if (shots.project !== undefined) return shots.project
  throw new KitError(
    'shots.project is not set',
    'Set shots.project in kit.config.ts to the saved project JSON, relative to the repo root',
    ExitCode.config,
  )
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
      PROJECT_HINT,
      ExitCode.config,
    )
  }
  return parseProject(value, file)
}

export { localeText, localizeSlide } from './resolve'
