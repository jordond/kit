import type { DeviceTarget } from '../devices'
import { ExitCode, KitError } from '../errors'
import {
  BUILT_IN_STYLE,
  derivedId,
  localizeSlide,
  resolveSlides,
  STYLE_SECTIONS,
  TARGET_FRAME,
} from './resolve'
import type { ProjectV1, ProjectV2, Slide, SlideLocaleText, SlideV2, StyleRules } from './types'

/**
 * Version 1 into version 2: the value most slides share becomes the project's `style`, a slide
 * that differs keeps its own under its `style`, and a value the built-in style already has is left
 * out. `roundTripDiffs` is the proof that the result draws the same slides.
 */

/** The fields of each style section a version 1 slide fills, in the order they are written. */
const FIELDS = {
  headline: [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'color',
    'align',
    'lineHeight',
    'shadow',
    'shadowColor',
    'shadowBlur',
  ],
  subheadline: [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'color',
    'align',
    'lineHeight',
    'shadow',
    'shadowColor',
    'shadowBlur',
  ],
  badge: ['enabled', 'text', 'icon', 'backgroundColor', 'textColor', 'borderColor', 'fontSize'],
  device: [
    'color',
    'position',
    'scale',
    'yOffset',
    'xOffset',
    'rotation',
    'perspectiveTilt',
    'shadowElevation',
    'shadowColor',
    'showReflection',
  ],
  background: ['type', 'primaryColor', 'secondaryColor', 'accentColor', 'angle', 'pattern'],
} as const

type Leaves = Map<string, unknown>

/** The rule values of one version 1 slide, keyed `section.field`. */
function leavesOf(slide: Slide): Leaves {
  const leaves: Leaves = new Map()
  const read = (section: keyof typeof FIELDS, from: object) => {
    for (const field of FIELDS[section])
      leaves.set(`${section}.${field}`, (from as Record<string, unknown>)[field])
  }
  read('headline', slide.headline)
  read('subheadline', slide.subheadline)
  read('badge', slide.badge)
  read('device', slide.device)
  read('background', slide.background)
  // `angled-3d` has no renderer branch: it has always drawn as `bottom-peek`.
  if (leaves.get('device.position') === 'angled-3d') leaves.set('device.position', 'bottom-peek')
  leaves.set('brand.show', slide.showMascot)
  leaves.set('brand.position', slide.mascotPosition)
  // The target's own frame and corner are derived in version 2, so they are not rules.
  const own = TARGET_FRAME[slide.platform]
  if (slide.device.frameType !== own.frameType || slide.device.cornerRadius !== own.cornerRadius) {
    leaves.set('device.frameType', slide.device.frameType)
    leaves.set('device.cornerRadius', slide.device.cornerRadius)
  }
  return leaves
}

const builtIn = (key: string): unknown => {
  const [section, field] = key.split('.') as [keyof typeof BUILT_IN_STYLE, string]
  return (BUILT_IN_STYLE[section] as Record<string, unknown>)[field]
}

/** The most common value of `values` (the first to reach the highest count wins a tie). */
function mostCommon(values: unknown[]): unknown {
  const counts = new Map<string, { value: unknown; n: number }>()
  for (const value of values) {
    const key = JSON.stringify(value) ?? 'undefined'
    const at = counts.get(key) ?? { value, n: 0 }
    at.n += 1
    counts.set(key, at)
  }
  let best: { value: unknown; n: number } | undefined
  for (const at of counts.values()) if (!best || at.n > best.n) best = at
  return best?.value
}

/** `rules.<section>.<field> = value`, creating the section. */
function setRule(rules: Record<string, Record<string, unknown>>, key: string, value: unknown): void {
  const [section, field] = key.split('.') as [string, string]
  const into = rules[section] ?? {}
  rules[section] = into
  into[field] = value
}

/** Section by section in the written order, so the file reads the same way every time. */
function ordered(rules: Record<string, Record<string, unknown>>): StyleRules | undefined {
  const out: Record<string, unknown> = {}
  for (const section of STYLE_SECTIONS) if (rules[section]) out[section] = rules[section]
  return Object.keys(out).length === 0 ? undefined : (out as StyleRules)
}

/**
 * The version 2 project that draws the same slides. Slides go in `order`; each id is derived from
 * the shot (and the `locales` keys follow), unless two shots derive the same id, when the slide
 * keeps its own.
 */
export function migrateProject(project: ProjectV1): ProjectV2 {
  const slides = [...project.slides].sort((a, b) => a.order - b.order)
  const leaves = slides.map(leavesOf)

  // A rule every slide agrees on, or most do, is the project's; the others carry their own.
  const style: Record<string, Record<string, unknown>> = {}
  const keys = [...new Set(leaves.flatMap((l) => [...l.keys()]))]
  const hoisted = new Map<string, unknown>()
  for (const key of keys) {
    const values = leaves.map((l) => l.get(key))
    const frame = key === 'device.frameType' || key === 'device.cornerRadius'
    // A derived frame cannot be un-set by a slide, so a frame rule is the project's only when no slide derives it.
    const common = mostCommon(values)
    const shared = frame
      ? values.every((v) => v !== undefined && v === common)
        ? common
        : undefined
      : common
    hoisted.set(key, shared)
    if (shared !== undefined && (frame || shared !== builtIn(key))) setRule(style, key, shared)
  }

  const derived = slides.map((s) => derivedId(s.sourceFile))
  const ids = slides.map((s, i) =>
    derived.indexOf(derived[i]!) === derived.lastIndexOf(derived[i]!) ? derived[i]! : s.id,
  )
  const rekey = new Map(slides.map((s, i) => [s.id, ids[i]!]))

  const out: SlideV2[] = slides.map((s, i) => {
    const own: Record<string, Record<string, unknown>> = {}
    let badge: string | undefined
    for (const [key, value] of leaves[i]!) {
      if (value === hoisted.get(key)) continue
      if (key === 'badge.text') badge = value as string
      else setRule(own, key, value)
    }
    const rules = ordered(own)
    return {
      shot: s.sourceFile,
      ...(ids[i] === derived[i] ? {} : { id: ids[i] }),
      ...(s.name === ids[i] ? {} : { name: s.name }),
      headline: s.headline.text,
      ...(s.subheadline.text === '' ? {} : { subheadline: s.subheadline.text }),
      ...(badge === undefined ? {} : { badge }),
      ...(rules ? { style: rules } : {}),
    }
  })

  const locales: Record<string, Record<string, SlideLocaleText>> = {}
  for (const [code, bySlide] of Object.entries(project.locales ?? {})) {
    locales[code] = Object.fromEntries(
      Object.entries(bySlide).map(([id, text]) => [rekey.get(id) ?? id, text]),
    )
  }

  const rules = ordered(style)
  return {
    version: 2,
    ...(rules ? { style: rules } : {}),
    slides: out,
    ...(project.locales ? { locales } : {}),
  }
}

/** What the page draws of a slide, in the fields version 2 keeps: no id, order, panorama (unless drawn) or dead fields. */
function canon(slide: Slide): Record<string, unknown> {
  const text = ({
    text,
    fontFamily,
    fontSize,
    fontWeight,
    color,
    align,
    lineHeight,
    shadow,
    shadowColor,
    shadowBlur,
  }: Slide['headline']) => ({
    text,
    fontFamily,
    fontSize,
    fontWeight,
    color,
    align,
    lineHeight,
    shadow,
    shadowColor,
    shadowBlur,
  })
  const bg = slide.background
  const device = { ...slide.device }
  if (device.position === 'angled-3d') device.position = 'bottom-peek'
  return {
    name: slide.name,
    sourceFile: slide.sourceFile,
    platform: slide.platform,
    badge: { ...slide.badge },
    headline: text(slide.headline),
    subheadline: text(slide.subheadline),
    device,
    background: {
      type: bg.type,
      primaryColor: bg.primaryColor,
      secondaryColor: bg.secondaryColor,
      accentColor: bg.accentColor,
      angle: bg.angle,
      pattern: bg.pattern,
      ...(bg.type === 'panorama'
        ? { panoramaTotalSlides: bg.panoramaTotalSlides, panoramaSlideIndex: bg.panoramaSlideIndex }
        : {}),
    },
    showMascot: slide.showMascot,
    mascotPosition: slide.mascotPosition,
  }
}

/** Every path at which two plain values differ, as `path: before -> after`. */
function diff(path: string, a: unknown, b: unknown, out: string[]): void {
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      diff(
        path ? `${path}.${key}` : key,
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        out,
      )
    }
    return
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a) ?? 'absent'} -> ${JSON.stringify(b) ?? 'absent'}`)
}

/**
 * The differences between the slides `before` (version 1) and `after` (its migration) draw, for
 * each target and, for every locale in `locales`, each locale: `slide <id> <target> <field>: ...`.
 * Empty when they draw the same. The removed fields and the derived ids are not compared.
 */
export function roundTripDiffs(before: ProjectV1, after: ProjectV2): string[] {
  const out: string[] = []
  const locales = ['', ...Object.keys(before.locales ?? {})]
  for (const target of Object.keys(TARGET_FRAME) as DeviceTarget[]) {
    const was = resolveSlides(before, target)
    const now = resolveSlides(after, target)
    if (was.length !== now.length) {
      out.push(`${target}: ${was.length} slides -> ${now.length}`)
      continue
    }
    was.forEach((slide, i) => {
      for (const locale of locales) {
        const a = canon(locale ? localizeSlide(before, slide, locale) : slide)
        const b = canon(locale ? localizeSlide(after, now[i]!, locale) : now[i]!)
        const found: string[] = []
        diff('', a, b, found)
        const where = `slide ${slide.id} ${target}${locale ? ` ${locale}` : ''}`
        for (const line of found) out.push(`${where} ${line}`)
      }
    })
  }
  return out
}

/** `migrateProject`, or a KitError (exit 4) naming each slide and field that would draw differently. */
export function migrateChecked(project: ProjectV1): ProjectV2 {
  const migrated = migrateProject(project)
  const diffs = roundTripDiffs(project, migrated)
  if (diffs.length > 0) {
    const shown = diffs.slice(0, 20)
    throw new KitError(
      `The migrated project would draw differently (${diffs.length} difference${diffs.length === 1 ? '' : 's'}); nothing was written:\n${shown.map((d) => `  ${d}`).join('\n')}${diffs.length > shown.length ? `\n  ... and ${diffs.length - shown.length} more` : ''}`,
      'Version 2 takes the target frame and corner from the target, and has no angled-3d: change that slide in the project, then migrate again',
      ExitCode.precondition,
    )
  }
  return migrated
}
