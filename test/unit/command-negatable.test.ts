import { describe, expect, test } from 'bun:test'
import { negatableDefaults } from '../../src/cli/command'

describe('negatableDefaults', () => {
  test('a boolean that defaults to true takes --no-<flag>', () => {
    const args = negatableDefaults({
      build: { type: 'boolean', default: true },
      keep: { type: 'boolean', default: true, negatable: false },
      force: { type: 'boolean' },
      out: { type: 'string', default: 'x' },
    })
    expect(args.build).toEqual({ type: 'boolean', default: true, negatable: true })
    expect(args.keep!.negatable).toBe(false)
    expect(args.force).toEqual({ type: 'boolean' })
    expect(args.out).toEqual({ type: 'string', default: 'x' })
  })
})
