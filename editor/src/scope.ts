import type { DeviceTarget } from '../../src/lib/devices'
import { BUILT_IN_STYLE, mergeRules, slideId, STYLE_SECTIONS } from '../../src/lib/storeshots/resolve'
import type { ProjectV2, SlideLocaleText, SlideV2, StyleRules } from '../../src/lib/storeshots/types'

/**
 * Reading and writing one field of a version 2 project at a scope. Pure: no DOM, no React, no
 * store. Every write returns a new project and leaves the argument alone, so the store can keep
 * the old one for undo.
 *
 * A style field lives in one of five layers, merged in this order (a later layer wins):
 * built-in, `style` (All slides), `targets[t]` (This target), the slide's `style` (This slide),
 * the slide's `targets[t]` (This slide on this target). An edit writes one layer and no other.
 * Content (shot, name, headline, subheadline, badge text, locale text) is the slide's own.
 */

export type StyleSection = (typeof STYLE_SECTIONS)[number]
export { STYLE_SECTIONS }

export type Scope = 'all' | 'target' | 'slide' | 'slide-target'
export const SCOPES: readonly Scope[] = ['all', 'target', 'slide', 'slide-target']

/** Where a value comes from: the layer that sets it. */
export type Source = 'built-in' | 'project' | 'target' | 'slide' | 'slide-target'

/** One style field: a key of one section of `StyleRules`. */
export interface FieldRef {
  section: StyleSection
  key: string
}

/** What a read or write is about: the target in focus, the slide (by position) and every target. */
export interface Place {
  target: DeviceTarget
  slide: number
  /** Every target of the session; a write at a scope that spans targets checks them all. */
  targets: readonly DeviceTarget[]
}

export type StyleValue = string | number | boolean | undefined

const SCOPE_SOURCE: Record<Scope, Source> = {
  all: 'project',
  target: 'target',
  slide: 'slide',
  'slide-target': 'slide-target',
}

/** The merge order, lowest first. */
const ORDER: readonly Source[] = ['built-in', 'project', 'target', 'slide', 'slide-target']

const rulesOf = (rules: StyleRules | undefined, field: FieldRef): StyleValue =>
  (rules?.[field.section] as Record<string, StyleValue> | undefined)?.[field.key]

/** The rules of each layer for one target, lowest first. A layer that is not there is `undefined`. */
function layers(project: ProjectV2, target: DeviceTarget, slide: number): [Source, StyleRules | undefined][] {
  const s = project.slides[slide]
  return [
    ['built-in', BUILT_IN_STYLE],
    ['project', project.style],
    ['target', project.targets?.[target]],
    ['slide', s?.style],
    ['slide-target', s?.targets?.[target]],
  ]
}

/** The value of `field` for `target`, using only the layers below `scope` (all of them when `scope` is absent). */
function valueFor(
  project: ProjectV2,
  target: DeviceTarget,
  slide: number,
  field: FieldRef,
  below?: Scope,
): { value: StyleValue; source: Source } {
  const stop = below === undefined ? ORDER.length : ORDER.indexOf(SCOPE_SOURCE[below])
  let found: { value: StyleValue; source: Source } = { value: undefined, source: 'built-in' }
  for (const [source, rules] of layers(project, target, slide)) {
    if (ORDER.indexOf(source) >= stop) break
    const value = rulesOf(rules, field)
    if (value !== undefined) found = { value, source }
  }
  return found
}

/** The value the field has for the slide on the target, and the layer it comes from. */
export const readField = (project: ProjectV2, place: Place, field: FieldRef) =>
  valueFor(project, place.target, place.slide, field)

/** Where the field's value comes from. */
export const sourceOf = (project: ProjectV2, place: Place, field: FieldRef): Source =>
  readField(project, place, field).source

/** True when `scope` itself sets the field (the layer is not empty for it). */
export function hasOverride(project: ProjectV2, scope: Scope, place: Place, field: FieldRef): boolean {
  return rulesOf(rulesAt(project, scope, place), field) !== undefined
}

/** The layer's rules, or `undefined` when there are none. */
function rulesAt(project: ProjectV2, scope: Scope, place: Place): StyleRules | undefined {
  const slide = project.slides[place.slide]
  switch (scope) {
    case 'all':
      return project.style
    case 'target':
      return project.targets?.[place.target]
    case 'slide':
      return slide?.style
    case 'slide-target':
      return slide?.targets?.[place.target]
  }
}

/**
 * What the field would be at `scope` with no override there: the layers below it. A scope that
 * spans targets (All slides, This slide) has one value per target; the override is redundant only
 * when `value` equals all of them.
 */
function inherited(project: ProjectV2, scope: Scope, place: Place, field: FieldRef): StyleValue[] {
  const spans = scope === 'all' || scope === 'slide'
  const targets = spans ? place.targets : [place.target]
  return targets.map((t) => valueFor(project, t, place.slide, field, scope).value)
}

/** `rules` with `field` set (or removed for `undefined`); an emptied section is dropped; `undefined` when nothing is left. */
function withField(
  rules: StyleRules | undefined,
  field: FieldRef,
  value: StyleValue,
): StyleRules | undefined {
  const section = { ...(rules?.[field.section] as Record<string, unknown> | undefined) }
  if (value === undefined) delete section[field.key]
  else section[field.key] = value
  const next: Record<string, unknown> = { ...rules }
  if (Object.keys(section).length > 0) next[field.section] = section
  else delete next[field.section]
  return Object.keys(next).length > 0 ? (next as StyleRules) : undefined
}

/** `map` with the key set (or removed for `undefined`); `undefined` when it ends up empty. */
function withKey<K extends string, V>(
  map: Partial<Record<K, V>> | undefined,
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> | undefined {
  const next: Partial<Record<K, V>> = { ...map }
  if (value === undefined) delete next[key]
  else next[key] = value
  return Object.keys(next).length > 0 ? next : undefined
}

/** An object with `key` set, or without it when `value` is `undefined`. */
function setOrDrop<T extends object>(obj: T, key: string, value: unknown): T {
  const next = { ...obj } as Record<string, unknown>
  if (value === undefined) delete next[key]
  else next[key] = value
  return next as T
}

function replaceSlide(project: ProjectV2, index: number, slide: SlideV2): ProjectV2 {
  return { ...project, slides: project.slides.map((s, i) => (i === index ? slide : s)) }
}

/** Writes the layer's rules back, dropping the key when they are empty. */
function putRules(project: ProjectV2, scope: Scope, place: Place, rules: StyleRules | undefined): ProjectV2 {
  switch (scope) {
    case 'all':
      return setOrDrop(project, 'style', rules)
    case 'target':
      return setOrDrop(project, 'targets', withKey(project.targets, place.target, rules))
    case 'slide': {
      const slide = project.slides[place.slide]
      return slide ? replaceSlide(project, place.slide, setOrDrop(slide, 'style', rules)) : project
    }
    case 'slide-target': {
      const slide = project.slides[place.slide]
      if (!slide) return project
      return replaceSlide(
        project,
        place.slide,
        setOrDrop(slide, 'targets', withKey(slide.targets, place.target, rules)),
      )
    }
  }
}

/**
 * Sets the field at `scope`. A value equal to what the layers below give removes the override
 * instead, so the file stays minimal; emptied sections and objects are pruned. `undefined` resets.
 */
export function writeField(
  project: ProjectV2,
  scope: Scope,
  place: Place,
  field: FieldRef,
  value: StyleValue,
): ProjectV2 {
  const redundant = value !== undefined && inherited(project, scope, place, field).every((v) => v === value)
  const next = withField(rulesAt(project, scope, place), field, redundant ? undefined : value)
  return putRules(project, scope, place, next)
}

/** Removes the override at `scope`; the value falls back to the layer below. */
export const resetField = (project: ProjectV2, scope: Scope, place: Place, field: FieldRef): ProjectV2 =>
  writeField(project, scope, place, field, undefined)

/**
 * Moves the slide's own override of the field to All slides: the project gets the value, the slide
 * loses it. The same slide on a single target (`slide-target`) is left as it is: it still wins.
 */
export function promoteField(project: ProjectV2, place: Place, field: FieldRef): ProjectV2 {
  const value = rulesOf(rulesAt(project, 'slide', place), field)
  if (value === undefined) return project
  const promoted = writeField(project, 'all', place, field, value)
  return resetField(promoted, 'slide', place, field)
}

/** The merged rules for one slide and target, for callers that want a whole section. */
export const mergedRules = (project: ProjectV2, target: DeviceTarget, slide: number): StyleRules =>
  mergeRules(...layers(project, target, slide).map(([, rules]) => rules))

// ---------------------------------------------------------------------------------------------
// Content: always the slide's own, whatever the scope.
// ---------------------------------------------------------------------------------------------

export type ContentField = 'name' | 'headline' | 'subheadline' | 'badge'

/** Sets a content field. Empty text removes an optional one; a headline stays (an empty string). */
export function setContent(project: ProjectV2, index: number, field: ContentField, value: string): ProjectV2 {
  const slide = project.slides[index]
  if (!slide) return project
  const keep = field === 'headline' || value !== ''
  return replaceSlide(project, index, setOrDrop(slide, field, keep ? value : undefined))
}

export type LocaleField = keyof SlideLocaleText

/** Sets one field of a slide's text in `locale`; empty removes it, and emptied entries are pruned. */
export function setLocaleText(
  project: ProjectV2,
  locale: string,
  id: string,
  field: LocaleField,
  value: string,
): ProjectV2 {
  const entry = setOrDrop({ ...project.locales?.[locale]?.[id] }, field, value === '' ? undefined : value)
  const slides = withKey(project.locales?.[locale], id, Object.keys(entry).length > 0 ? entry : undefined)
  return setOrDrop(project, 'locales', withKey(project.locales, locale, slides))
}

// ---------------------------------------------------------------------------------------------
// Slides.
// ---------------------------------------------------------------------------------------------

/** A readable first headline from a shot's file name: `02-my-map.png` is `My map`. */
export function titleOf(shot: string): string {
  const words = slideId({ shot })
    .replace(/[-_.]+/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** An id not taken by another slide: `id`, then `id-2`, `id-3`. */
function freeId(id: string, taken: ReadonlySet<string>): string {
  let out = id
  for (let n = 2; taken.has(out); n++) out = `${id}-${n}`
  return out
}

const idsOf = (project: ProjectV2, except?: number): Set<string> =>
  new Set(project.slides.flatMap((s, i) => (i === except ? [] : [slideId(s)])))

/**
 * Appends a slide for a raw shot (at `index`, default the end). Never a copy: it has the shot and
 * a headline from the file name, and takes its look from the project's rules. A shot whose derived
 * id is taken gets an explicit one.
 */
export function addSlide(project: ProjectV2, shot: string, index = project.slides.length): ProjectV2 {
  const taken = idsOf(project)
  const derived = slideId({ shot })
  const slide: SlideV2 = { shot, headline: titleOf(shot) }
  if (taken.has(derived)) slide.id = freeId(derived, taken)
  const slides = [...project.slides]
  slides.splice(Math.min(Math.max(index, 0), slides.length), 0, slide)
  return { ...project, slides }
}

/** Drops the slide and the locale text keyed to its id (when no other slide has that id). */
export function removeSlide(project: ProjectV2, index: number): ProjectV2 {
  const slide = project.slides[index]
  if (!slide) return project
  const id = slideId(slide)
  const slides = project.slides.filter((_, i) => i !== index)
  let next: ProjectV2 = { ...project, slides }
  for (const locale of Object.keys(project.locales ?? {})) {
    const rest = withKey(next.locales?.[locale], id, undefined)
    next = setOrDrop(next, 'locales', withKey(next.locales, locale, rest))
  }
  return next
}

/** Moves a slide: order is array position. */
export function moveSlide(project: ProjectV2, from: number, to: number): ProjectV2 {
  if (from === to || !project.slides[from] || to < 0 || to >= project.slides.length) return project
  const slides = [...project.slides]
  const [moved] = slides.splice(from, 1)
  slides.splice(to, 0, moved!)
  return { ...project, slides }
}

/**
 * Points a slide at another raw shot. The slide's id follows the shot unless it sets one; its
 * locale text is re-keyed with it, or, when the new id is taken by another slide, the old id is
 * kept explicitly so nothing collides.
 */
export function setShot(project: ProjectV2, index: number, shot: string): ProjectV2 {
  const slide = project.slides[index]
  if (!slide || slide.shot === shot) return project
  const from = slideId(slide)
  const to = slideId({ ...slide, shot })
  let next = replaceSlide(project, index, { ...slide, shot })
  if (from === to) return next
  if (idsOf(project, index).has(to)) return replaceSlide(next, index, { ...slide, shot, id: from })
  if (slide.id === undefined && project.locales) {
    const locales: NonNullable<ProjectV2['locales']> = {}
    for (const [code, slides] of Object.entries(project.locales)) {
      const { [from]: moved, ...rest } = slides
      locales[code] = moved ? { ...rest, [to]: moved } : rest
    }
    next = { ...next, locales }
  }
  return next
}

/** A new project: one slide per raw shot file, in file-name order. */
export function projectFromShots(files: readonly string[]): ProjectV2 {
  const sorted = [...new Set(files)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return sorted.reduce<ProjectV2>((project, file) => addSlide(project, file), { version: 2, slides: [] })
}
