import { describe, expect, test } from 'bun:test'
import { cssFamily, fontStack, GENERIC_FAMILIES, isGenericFamily } from '../../src/lib/storeshots/fonts'

describe('font families', () => {
  test('a CSS generic is emitted bare: in quotes Chrome looks for a font of that name', () => {
    for (const family of GENERIC_FAMILIES) {
      expect(isGenericFamily(family)).toBe(true)
      expect(cssFamily(family)).toBe(family)
      expect(fontStack(family)).toBe(`${family}, sans-serif`)
    }
    expect(cssFamily(' Serif ')).toBe('serif')
    expect(fontStack('MONOSPACE')).toBe('monospace, sans-serif')
  })

  test('a named family is quoted, with what would end the quotes escaped', () => {
    expect(isGenericFamily('Nunito')).toBe(false)
    expect(isGenericFamily('Serif Display')).toBe(false)
    expect(fontStack('Nunito')).toBe('"Nunito", sans-serif')
    expect(cssFamily('Kit Fixture')).toBe('"Kit Fixture"')
    expect(cssFamily('A "B" \\ C')).toBe('"A \\"B\\" \\\\ C"')
  })
})
