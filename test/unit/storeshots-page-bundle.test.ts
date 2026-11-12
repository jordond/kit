import { describe, expect, test } from 'bun:test'
import { pageBundle } from '../../src/lib/storeshots/page-bundle'

describe('pageBundle', () => {
  test('bundles the page from source into one browser script', async () => {
    const js = await pageBundle()
    expect(js.length).toBeGreaterThan(1000)
    // One self-contained file: the server serves nothing else for it to import.
    expect(js).not.toMatch(/^\s*import\s/m)
    expect(js).not.toContain('require(')
    expect(() => new Bun.Transpiler({ loader: 'js' }).scan(js)).not.toThrow()
  })

  test('the bundle speaks the page protocol', async () => {
    const js = await pageBundle()
    for (const path of ['plan.json', 'shot/', 'out/', 'done']) expect(js).toContain(path)
    expect(js).toContain('image/png')
    // Fonts are loaded and verified before the first draw.
    expect(js).toContain('FontFace')
    expect(js).toContain('fonts.check')
    // The canvas is opaque, so Chrome writes RGB.
    expect(js).toMatch(/alpha:\s*false/)
  })

  test('nothing of brewd is hard-coded in the renderer', async () => {
    const js = await pageBundle()
    for (const word of ['brewd', 'Baloo', 'Nunito', '/brand/logo.svg', '#faf2e4', '#46291B']) {
      expect(js).not.toContain(word)
    }
  })
})
