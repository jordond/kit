import {
  BACKGROUND_PATTERNS,
  BACKGROUND_TYPES,
  BADGE_ICONS,
  DEVICE_POSITIONS,
  FRAME_COLORS,
  FRAME_TYPES,
  MASCOT_POSITIONS,
  SHADOW_ELEVATIONS,
} from '../../../src/lib/storeshots/types'
import type { FieldRef, StyleSection } from '../scope'

/**
 * What the panel offers for each style field the renderer reads. The value lists of the enum
 * fields come from kit source (`types.ts`), not from retyping them here.
 */

export interface Option {
  value: string
  label: string
}

export type Control =
  | { kind: 'number'; min: number; max: number; step: number; unit?: string; optional?: boolean }
  | { kind: 'color' }
  | { kind: 'toggle' }
  | { kind: 'font' }
  /** `auto` is the label of the empty choice: the field is not set. */
  | { kind: 'select'; options: readonly Option[]; auto?: string }
  | { kind: 'segmented'; options: readonly Option[] }

export interface FieldSpec {
  field: FieldRef
  label: string
  control: Control
}

export interface Block {
  title?: string
  fields: FieldSpec[]
}

export interface Group {
  id: string
  title: string
  open: boolean
  blocks: Block[]
}

const words = (value: string): string => {
  const text = value.replace(/-/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const options = (values: readonly string[]): Option[] =>
  values.map((value) => ({ value, label: words(value) }))

/** The platform frames follow the target, so the choice is "the target's own" or one of the others. */
const OTHER_FRAMES = FRAME_TYPES.filter((f) => !['iphone-pro', 'ipad-pro', 'android-pixel'].includes(f))

/** `angled-3d` is not in version 2: the renderer never had a branch for it. */
const POSITIONS = DEVICE_POSITIONS.filter((p) => p !== 'angled-3d')

const f = (section: StyleSection, key: string, label: string, control: Control): FieldSpec => ({
  field: { section, key },
  label,
  control,
})

const textFields = (section: 'headline' | 'subheadline'): FieldSpec[] => [
  f(section, 'fontFamily', 'Font', { kind: 'font' }),
  f(section, 'fontSize', 'Size', { kind: 'number', min: 40, max: 200, step: 1, unit: '%' }),
  f(section, 'fontWeight', 'Weight', { kind: 'number', min: 100, max: 900, step: 100 }),
  f(section, 'color', 'Colour', { kind: 'color' }),
  f(section, 'align', 'Align', {
    kind: 'segmented',
    options: [
      { value: 'left', label: 'Left' },
      { value: 'center', label: 'Centre' },
      { value: 'right', label: 'Right' },
    ],
  }),
  f(section, 'lineHeight', 'Line height', { kind: 'number', min: 0.8, max: 2, step: 0.01 }),
  f(section, 'shadow', 'Shadow', { kind: 'toggle' }),
  f(section, 'shadowColor', 'Shadow colour', { kind: 'color' }),
  f(section, 'shadowBlur', 'Shadow blur', { kind: 'number', min: 0, max: 40, step: 1 }),
]

/** The groups of the panel after Slide (which is content, not style). */
export const STYLE_GROUPS: Group[] = [
  {
    id: 'text',
    title: 'Text',
    open: true,
    blocks: [
      { title: 'Headline', fields: textFields('headline') },
      { title: 'Subheadline', fields: textFields('subheadline') },
    ],
  },
  {
    id: 'badge',
    title: 'Badge',
    open: false,
    blocks: [
      {
        fields: [
          f('badge', 'enabled', 'Show badge', { kind: 'toggle' }),
          f('badge', 'icon', 'Icon', { kind: 'select', options: options(BADGE_ICONS) }),
          f('badge', 'backgroundColor', 'Background', { kind: 'color' }),
          f('badge', 'textColor', 'Text colour', { kind: 'color' }),
          f('badge', 'borderColor', 'Border', { kind: 'color' }),
          f('badge', 'fontSize', 'Size', { kind: 'number', min: 40, max: 200, step: 1, unit: '%' }),
        ],
      },
    ],
  },
  {
    id: 'device',
    title: 'Device',
    open: true,
    blocks: [
      {
        fields: [
          f('device', 'frameType', 'Frame', {
            kind: 'select',
            options: options(OTHER_FRAMES),
            auto: "The target's own",
          }),
          f('device', 'color', 'Finish', { kind: 'select', options: options(FRAME_COLORS) }),
          f('device', 'position', 'Position', { kind: 'select', options: options(POSITIONS) }),
          f('device', 'scale', 'Scale', { kind: 'number', min: 0.3, max: 1.5, step: 0.01 }),
          f('device', 'xOffset', 'X offset', { kind: 'number', min: -50, max: 50, step: 0.5, unit: '%' }),
          f('device', 'yOffset', 'Y offset', { kind: 'number', min: -50, max: 50, step: 0.5, unit: '%' }),
          f('device', 'rotation', 'Rotation', { kind: 'number', min: -45, max: 45, step: 1, unit: '°' }),
          f('device', 'perspectiveTilt', 'Tilt', { kind: 'number', min: -100, max: 100, step: 1 }),
          f('device', 'shadowElevation', 'Shadow', { kind: 'select', options: options(SHADOW_ELEVATIONS) }),
          f('device', 'shadowColor', 'Shadow colour', { kind: 'color' }),
          f('device', 'showReflection', 'Reflection', { kind: 'toggle' }),
          f('device', 'cornerRadius', 'Corner radius', {
            kind: 'number',
            min: 0,
            max: 200,
            step: 1,
            optional: true,
          }),
        ],
      },
    ],
  },
  {
    id: 'background',
    title: 'Background',
    open: false,
    blocks: [
      {
        fields: [
          f('background', 'type', 'Type', { kind: 'select', options: options(BACKGROUND_TYPES) }),
          f('background', 'primaryColor', 'Primary', { kind: 'color' }),
          f('background', 'secondaryColor', 'Secondary', { kind: 'color' }),
          f('background', 'accentColor', 'Accent', { kind: 'color' }),
          f('background', 'angle', 'Angle', { kind: 'number', min: 0, max: 360, step: 1, unit: '°' }),
          f('background', 'pattern', 'Pattern', { kind: 'select', options: options(BACKGROUND_PATTERNS) }),
        ],
      },
    ],
  },
  {
    id: 'brand',
    title: 'Brand',
    open: false,
    blocks: [
      {
        fields: [
          f('brand', 'show', 'Show brand', { kind: 'toggle' }),
          f('brand', 'position', 'Position', { kind: 'select', options: options(MASCOT_POSITIONS) }),
        ],
      },
    ],
  },
]

/** CSS generic families, always offered beside the fonts of `shots.fonts`. */
export const GENERIC_FONTS = ['sans-serif', 'serif', 'monospace', 'system-ui'] as const
