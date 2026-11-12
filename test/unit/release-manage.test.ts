import { describe, expect, test } from 'bun:test'
import { ExitCode, KitError } from '../../src/lib/errors'
import { playBuildToPromote, validatePromotion } from '../../src/lib/release/promote'
import { describeRollout, rolloutPlan, widensExposure } from '../../src/lib/release/rollout'
import {
  parseAndroidStatus,
  parseIosStatus,
  requireBundle,
  requirePlatform,
} from '../../src/lib/release/status'

/** The KitError `fn` throws. */
function thrown(fn: () => unknown): KitError {
  try {
    fn()
  } catch (e) {
    if (e instanceof KitError) return e
    throw e
  }
  throw new Error('expected a KitError')
}

describe('validatePromotion', () => {
  test('allows only later tracks', () => {
    expect(validatePromotion('alpha', 'beta')).toEqual({ from: 'alpha', to: 'beta' })
    expect(validatePromotion('alpha', 'prod')).toEqual({ from: 'alpha', to: 'prod' })
    expect(validatePromotion('beta', 'prod')).toEqual({ from: 'beta', to: 'prod' })
  })

  test('internal is refused with the reason and a rebuild hint', () => {
    const e = thrown(() => validatePromotion('internal', 'beta'))
    expect(e.exitCode).toBe(ExitCode.usage)
    expect(e.message).toContain('Internal builds are never promoted')
    expect(e.message).toContain('KIT_INTERNAL')
    expect(e.hint).toContain('kit release <platform> --track beta')
  })

  test('same or earlier destination is a usage error', () => {
    for (const [from, to] of [
      ['beta', 'beta'],
      ['beta', 'alpha'],
      ['alpha', 'alpha'],
      ['alpha', 'internal'],
      ['prod', 'prod'],
    ]) {
      expect(thrown(() => validatePromotion(from, to)).exitCode).toBe(ExitCode.usage)
    }
    expect(thrown(() => validatePromotion('beta', 'beta')).message).toContain('later track')
  })

  test('both flags are required', () => {
    expect(thrown(() => validatePromotion(undefined, 'prod')).exitCode).toBe(ExitCode.usage)
    expect(thrown(() => validatePromotion('alpha', undefined)).message).toContain('--from')
  })
})

describe('status parsing', () => {
  test('android: codes, names, empty and unknown tracks', () => {
    const tracks = parseAndroidStatus({
      STATUS_INTERNAL_CODES: '42,41',
      STATUS_INTERNAL_NAMES: '["1.4.0","1.4.0 (hotfix, a)"]',
      STATUS_ALPHA_CODES: '40',
      STATUS_BETA_ERROR: 'Google Api Error: forbidden',
      STATUS_PRODUCTION_CODES: '',
    })
    expect(tracks).toEqual([
      { track: 'internal', state: 'ok', build: 42, codes: [41, 42], names: ['1.4.0', '1.4.0 (hotfix, a)'] },
      { track: 'alpha', state: 'ok', build: 40, codes: [40] },
      { track: 'beta', state: 'unknown', build: null, error: 'Google Api Error: forbidden' },
      { track: 'prod', state: 'empty', build: null, codes: [] },
    ])
  })

  test('android: a lane that reported nothing leaves every track unknown', () => {
    expect(parseAndroidStatus({}).every((t) => t.state === 'unknown' && t.error)).toBe(true)
  })

  test('ios: testflight and the live App Store build', () => {
    expect(
      parseIosStatus({
        STATUS_TESTFLIGHT_BUILD: '7',
        STATUS_TESTFLIGHT_VERSION: '1.4.0',
        STATUS_APPSTORE_BUILD: '5',
        STATUS_APPSTORE_VERSION: '1.3.0',
        STATUS_APPSTORE_PHASED: 'ACTIVE',
      }),
    ).toEqual([
      { track: 'testflight', state: 'ok', build: 7, version: '1.4.0' },
      { track: 'prod', state: 'ok', build: 5, version: '1.3.0', phased: 'ACTIVE' },
    ])
    expect(parseIosStatus({ STATUS_TESTFLIGHT_ERROR: 'no key', STATUS_APPSTORE_BUILD: '' })).toEqual([
      { track: 'testflight', state: 'unknown', build: null, error: 'no key' },
      { track: 'prod', state: 'empty', build: null },
    ])
  })

  test('playBuildToPromote: the highest code on the source track; empty and unreadable differ', () => {
    const android = { STATUS_ALPHA_CODES: '39,40', STATUS_BETA_CODES: '' }
    expect(playBuildToPromote('alpha', android)).toBe(40)
    expect(thrown(() => playBuildToPromote('beta', android)).message).toBe(
      'No release on the Play beta track to promote',
    )
    const unreadable = thrown(() => playBuildToPromote('beta', { STATUS_BETA_ERROR: 'forbidden' }))
    expect(unreadable.message).toBe('Could not read the Play beta track: forbidden')
    expect(thrown(() => playBuildToPromote('alpha', {})).message).toContain(
      'Could not read the Play alpha track',
    )
  })
})

describe('rolloutPlan', () => {
  test('one action per run', () => {
    expect(rolloutPlan('android', { halt: true })).toEqual({ action: 'halt' })
    expect(rolloutPlan('android', { resume: true })).toEqual({ action: 'resume' })
    expect(rolloutPlan('ios', { complete: true })).toEqual({ action: 'complete' })
    expect(thrown(() => rolloutPlan('android', {})).exitCode).toBe(ExitCode.usage)
    const two = thrown(() => rolloutPlan('android', { halt: true, resume: true }))
    expect(two.exitCode).toBe(ExitCode.usage)
    expect(two.message).toContain(
      'exactly one of --percent, --halt, --resume, --complete (got --halt, --resume)',
    )
    expect(thrown(() => rolloutPlan('android', { percent: 10, complete: true })).exitCode).toBe(
      ExitCode.usage,
    )
  })

  test('--build is an Android version code', () => {
    expect(rolloutPlan('android', { halt: true, build: 41 })).toEqual({ action: 'halt', build: 41 })
    expect(rolloutPlan('android', { percent: 50, build: 41 })).toEqual({
      action: 'percent',
      percent: 50,
      fraction: 0.5,
      build: 41,
    })
    expect(thrown(() => rolloutPlan('android', { halt: true, build: 0 })).exitCode).toBe(ExitCode.usage)
    expect(thrown(() => rolloutPlan('ios', { halt: true, build: 41 })).message).toContain(
      '--build is Android only',
    )
  })

  test('--percent becomes the Play user fraction', () => {
    expect(rolloutPlan('android', { percent: 25 })).toEqual({
      action: 'percent',
      percent: 25,
      fraction: 0.25,
    })
    expect(rolloutPlan('android', { percent: 7 })).toEqual({ action: 'percent', percent: 7, fraction: 0.07 })
    expect(rolloutPlan('android', { percent: 100 }).fraction).toBe(1)
    for (const percent of [0, 0.5, 101, -1, Number.NaN]) {
      const e = thrown(() => rolloutPlan('android', { percent }))
      expect(e.exitCode).toBe(ExitCode.usage)
      expect(e.message).toContain('between 1 and 100')
    }
  })

  test('iOS has no percentage', () => {
    const e = thrown(() => rolloutPlan('ios', { percent: 50 }))
    expect(e.exitCode).toBe(ExitCode.usage)
    expect(e.message).toContain('the App Store has no rollout percentage')
    expect(e.hint).toBe('Use --halt, --resume or --complete')
    expect(thrown(() => rolloutPlan('ios', {})).message).toContain(
      'exactly one of --halt, --resume, --complete',
    )
  })

  test('only --halt narrows production exposure', () => {
    expect(widensExposure('halt')).toBe(false)
    expect((['percent', 'resume', 'complete'] as const).map(widensExposure)).toEqual([true, true, true])
  })

  test('describeRollout', () => {
    expect(describeRollout('android', { action: 'percent', percent: 25, fraction: 0.25 })).toBe(
      'set the Play production rollout to 25%',
    )
    expect(describeRollout('android', { action: 'percent', percent: 100, fraction: 1 })).toContain('complete')
    expect(describeRollout('ios', { action: 'halt' })).toBe('pause the App Store phased release')
  })
})

describe('shared checks', () => {
  test('requirePlatform', () => {
    expect(requirePlatform('ios', 'kit release rollout <ios|android>')).toBe('ios')
    const e = thrown(() => requirePlatform('web', 'kit release rollout <ios|android>'))
    expect(e.exitCode).toBe(ExitCode.usage)
    expect(e.message).toBe('kit release rollout needs a platform: ios or android (got "web")')
  })

  test('requireBundle', () => {
    expect(() => requireBundle(() => '/usr/bin/bundle')).not.toThrow()
    expect(thrown(() => requireBundle(() => null)).exitCode).toBe(ExitCode.precondition)
  })
})
