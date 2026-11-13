import { describe, expect, test } from 'bun:test'
import { applyPreset, presetList } from '../../editor/src/presets'
import { styleRules } from '../../src/lib/storeshots/project'
import { BUILT_IN_PRESETS } from '../../src/lib/storeshots/presets'
import type { ProjectV2 } from '../../src/lib/storeshots/types'

const project = (style?: ProjectV2['style']): ProjectV2 => ({
  version: 2,
  ...(style ? { style } : {}),
  slides: [{ shot: '01-a.png', headline: 'A', style: { device: { scale: 0.5 } } }],
})

describe('presets', () => {
  test('kit ships light, dark and a bold colour preset, each valid under the strict style schema', () => {
    expect(Object.keys(BUILT_IN_PRESETS)).toEqual(['light', 'dark', 'bold-colour'])
    for (const rules of Object.values(BUILT_IN_PRESETS))
      expect(styleRules.safeParse(rules).success).toBe(true)
  })

  test('the list is the built-in presets, then the repo ones; a repo preset replaces a built-in of its name', () => {
    expect(presetList({}).map((p) => [p.name, p.fromRepo])).toEqual([
      ['light', false],
      ['dark', false],
      ['bold-colour', false],
    ])
    const own = { background: { primaryColor: '#f4ecd8' } }
    const list = presetList({ sand: own, dark: { headline: { color: '#eeeeee' } } })
    expect(list.map((p) => p.name)).toEqual(['light', 'bold-colour', 'sand', 'dark'])
    expect(list.find((p) => p.name === 'dark')).toEqual({
      name: 'dark',
      rules: { headline: { color: '#eeeeee' } },
      fromRepo: true,
    })
  })

  test('applying merges into the project style: preset fields win, the rest stay', () => {
    const before = project({ headline: { fontFamily: 'Serif', color: '#000000' }, device: { scale: 0.9 } })
    const after = applyPreset(before, {
      headline: { color: '#ffffff' },
      background: { primaryColor: '#111111' },
    })
    expect(after.style).toEqual({
      headline: { fontFamily: 'Serif', color: '#ffffff' },
      device: { scale: 0.9 },
      background: { primaryColor: '#111111' },
    })
    // The argument is not changed, and slide overrides are untouched.
    expect(before.style?.headline?.color).toBe('#000000')
    expect(after.slides).toBe(before.slides)
  })

  test('applying to a project with no style creates it', () => {
    expect(applyPreset(project(), BUILT_IN_PRESETS.dark!).style).toEqual(BUILT_IN_PRESETS.dark!)
  })

  test('a preset the style already has is the same project, and an empty one leaves no style key', () => {
    const p = project({ headline: { color: '#fff' } })
    expect(applyPreset(p, { headline: { color: '#fff' } })).toBe(p)
    expect(applyPreset(project(), {})).toEqual(project())
    expect('style' in applyPreset(project(), {})).toBe(false)
  })
})
