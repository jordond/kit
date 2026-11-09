import { describe, expect, test } from 'bun:test'
import { hasXcode } from '../../src/commands/xcode'

describe('hasXcode', () => {
  test('the app in /Applications or xcodebuild on PATH counts; neither is missing', () => {
    expect(
      hasXcode(
        () => false,
        (p) => p === '/Applications/Xcode.app',
      ),
    ).toBe(true)
    expect(
      hasXcode(
        (b) => b === 'xcodebuild',
        () => false,
      ),
    ).toBe(true)
    expect(
      hasXcode(
        () => false,
        () => false,
      ),
    ).toBe(false)
  })
})
