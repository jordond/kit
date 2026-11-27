import { describe, expect, test } from 'bun:test'
import { configSchema } from '../../src/config/schema'
import { SET_SIZES } from '../../src/lib/storeshots/sizes'
import {
  chooseScale,
  MIN_VIEWPORT_WIDTH,
  narrowViewport,
  viewportProblem,
} from '../../src/lib/storeshots/viewport'

/** The scale kit picks, the config rule for a scale the author picks, and the after-load check. */

describe('chooseScale', () => {
  test('is the largest scale that divides both sides and keeps the viewport 500 CSS px wide', () => {
    // 1440 / 4 = 360 and 1440 / 3 = 480 are too narrow.
    expect(chooseScale(1440, 2560)).toBe(2)
    // 1320 / 3 = 440 is too narrow.
    expect(chooseScale(1320, 2868)).toBe(2)
    // 2064 / 4 = 516.
    expect(chooseScale(2064, 2752)).toBe(4)
    expect(chooseScale(3000, 1500)).toBe(4)
    // 3 divides both sides, 4 does not.
    expect(chooseScale(1500, 3003)).toBe(3)
    expect(chooseScale(501, 999)).toBe(1)
  })

  test('every store set has a scale, and its viewport is never under the minimum', () => {
    for (const { width, height } of Object.values(SET_SIZES)) {
      const scale = chooseScale(width, height)!
      expect(width % scale).toBe(0)
      expect(height % scale).toBe(0)
      expect(width / scale).toBeGreaterThanOrEqual(MIN_VIEWPORT_WIDTH)
    }
  })

  test('is undefined for a PNG narrower than the minimum', () => {
    expect(chooseScale(499, 1000)).toBeUndefined()
  })
})

describe('narrowViewport', () => {
  test('names the page, the sum and the scale to use', () => {
    expect(narrowViewport('page store-phone', 1440, 2560, 4)).toBe(
      "page store-phone: 1440 / 4 = 360 CSS px is narrower than headless Chrome's 500 minimum; use scale 2",
    )
    expect(narrowViewport('page icon', 400, 400, 1)).toContain('make it at least 500 px wide')
  })

  test('passes a viewport of 500 or more', () => {
    expect(narrowViewport('page a', 1440, 2560, 2)).toBeUndefined()
    expect(narrowViewport('page a', 1000, 800, 2)).toBeUndefined()
  })
})

describe('shots.pages scale in the config', () => {
  const parse = (page: object) =>
    configSchema.safeParse({
      name: 'x',
      targets: {},
      shots: { pages: [{ name: 'store-phone', file: 'a.html', ...page }] },
    })

  test('a viewport under 500 CSS px is rejected with the fix', () => {
    const result = parse({ width: 1440, height: 2560, scale: 4 })
    expect(result.success).toBe(false)
    const issue = result.error!.issues.find((i) => i.path.join('.') === 'shots.pages.0.scale')
    expect(issue?.message).toBe(
      "page store-phone: 1440 / 4 = 360 CSS px is narrower than headless Chrome's 500 minimum; use scale 2",
    )
  })

  test('the default scale of 2 is checked too', () => {
    const result = parse({ width: 800, height: 600 })
    expect(result.success).toBe(false)
    expect(result.error!.issues[0]!.message).toContain('800 / 2 = 400 CSS px')
    expect(result.error!.issues[0]!.message).toContain('use scale 1')
  })

  test('a viewport of 500 or more passes', () => {
    expect(parse({ width: 1440, height: 2560, scale: 2 }).success).toBe(true)
    expect(parse({ width: 2064, height: 2752, scale: 4 }).success).toBe(true)
  })
})

describe('viewportProblem', () => {
  test('nothing when the page was laid out at the size asked for', () => {
    expect(viewportProblem({ width: 720, height: 1280 }, { width: 720, height: 1280 })).toBeUndefined()
  })

  test('names both sizes, and the minimum when the asked width is under it', () => {
    const narrow = viewportProblem({ width: 360, height: 640 }, { width: 500, height: 640 })!
    expect(narrow.message).toBe('was laid out at 500x640 CSS px, not 360x640')
    expect(narrow.hint).toContain('500')
    const short = viewportProblem({ width: 720, height: 1280 }, { width: 720, height: 1193 })!
    expect(short.message).toBe('was laid out at 720x1193 CSS px, not 720x1280')
  })
})
