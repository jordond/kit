import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createClient } from '../../src/lib/iap/http'
import type { PlaySubscriptionDesired } from '../../src/lib/iap/model'
import { toMoney } from '../../src/lib/iap/play'
import {
  diffPlaySubscriptions,
  type PlaySubscriptionsObserved,
  playSubscriptionsAdapter,
} from '../../src/lib/iap/play-subscriptions'
import { type Fakes, startFakes } from '../helpers/iap-fakes'

const desired = (over: Partial<PlaySubscriptionDesired> = {}): PlaySubscriptionDesired => ({
  productId: 'pro',
  listings: { 'en-US': { title: 'Pro', description: 'Everything.', benefits: ['A', 'B'] } },
  basePlans: [
    { basePlanId: 'monthly', period: 'P1M', price: '4.99', trial: 'P1W', legacyCompatible: true },
    { basePlanId: 'yearly', period: 'P1Y', price: '39.99', legacyCompatible: false },
  ],
  ...over,
})

const plan = (id: string, period: string, price: string, over: Record<string, unknown> = {}) => ({
  basePlanId: id,
  state: 'ACTIVE',
  autoRenewingBasePlanType: { billingPeriodDuration: period, legacyCompatible: id === 'monthly' },
  regionalConfigs: [
    { regionCode: 'US', price: toMoney(price) },
    { regionCode: 'DE', price: toMoney('1.11', 'EUR') },
  ],
  ...over,
})

const sub = (over: Record<string, unknown> = {}) => ({
  productId: 'pro',
  listings: [{ languageCode: 'en-US', title: 'Pro', description: 'Everything.', benefits: ['A', 'B'] }],
  basePlans: [plan('monthly', 'P1M', '4.99'), plan('yearly', 'P1Y', '39.99')],
  ...over,
})

const trialOffer = (over: Record<string, unknown> = {}) => ({
  offerId: 'free-trial',
  state: 'ACTIVE',
  phases: [{ duration: 'P1W', regionalConfigs: [{ regionCode: 'US', free: {} }] }],
  ...over,
})

const observed = (
  subscriptions: PlaySubscriptionsObserved['subscriptions'],
  offers: PlaySubscriptionsObserved['offers'] = { 'pro/monthly': [trialOffer()] },
): PlaySubscriptionsObserved => ({ packageName: 'app.example', subscriptions, offers })

describe('diffPlaySubscriptions', () => {
  test('missing: error-free create, activate each plan, trial, activate trial', () => {
    const d = diffPlaySubscriptions([desired()], observed([], {}))
    expect(d.actions.map((a) => `${a.id} ${a.kind}: ${a.summary}`)).toEqual([
      'pro upsert: create · monthly 4.99 US, yearly 39.99 US (+ converted regions)',
      'pro activate: activate base plan monthly',
      'pro activate: activate base plan yearly',
      'pro trial: create monthly free-trial P1W',
      'pro activate-offer: activate monthly free-trial',
    ])
    expect(d.rows).toEqual([{ store: 'play', id: 'pro', sync: 'missing', notes: [] }])
  })

  test('in sync; FX-moved regional prices are not drift', () => {
    const moved = sub({ basePlans: [plan('monthly', 'P1M', '4.99'), plan('yearly', 'P1Y', '39.99')] })
    moved.basePlans[1]!.regionalConfigs[1] = { regionCode: 'DE', price: toMoney('99.00', 'EUR') }
    const d = diffPlaySubscriptions([desired()], observed([moved]))
    expect(d.actions).toEqual([])
    expect(d.rows[0]).toMatchObject({ sync: 'in-sync', storeState: 'monthly ACTIVE, yearly ACTIVE' })
  })

  test('differs: each field', () => {
    const cases: [string, Record<string, unknown>, Partial<PlaySubscriptionDesired>, string[], string[]][] = [
      [
        'title',
        {
          listings: [
            { languageCode: 'en-US', title: 'Old', description: 'Everything.', benefits: ['A', 'B'] },
          ],
        },
        {},
        ['listing en-US'],
        ['upsert'],
      ],
      [
        'benefits',
        { listings: [{ languageCode: 'en-US', title: 'Pro', description: 'Everything.', benefits: ['A'] }] },
        {},
        ['listing en-US'],
        ['upsert'],
      ],
      [
        'new language',
        {},
        {
          listings: { ...desired().listings, 'fr-FR': { title: 'Pro', description: 'Tout.', benefits: [] } },
        },
        ['listing fr-FR'],
        ['upsert'],
      ],
      [
        'new plan',
        { basePlans: [plan('monthly', 'P1M', '4.99')] },
        {},
        ['yearly: base plan'],
        ['upsert', 'activate'],
      ],
      [
        'legacy flag',
        {
          basePlans: [
            plan('monthly', 'P1M', '4.99', {
              autoRenewingBasePlanType: { billingPeriodDuration: 'P1M', legacyCompatible: false },
            }),
            plan('yearly', 'P1Y', '39.99'),
          ],
        },
        {},
        ['monthly: legacyCompatible'],
        ['upsert'],
      ],
      [
        'draft plan',
        { basePlans: [plan('monthly', 'P1M', '4.99'), plan('yearly', 'P1Y', '39.99', { state: 'DRAFT' })] },
        {},
        [],
        ['activate'],
      ],
    ]
    for (const [name, o, d, fields, kinds] of cases) {
      const r = diffPlaySubscriptions([desired(d)], observed([sub(o)]))
      expect({ name, fields: r.rows[0]!.fields ?? [], kinds: r.actions.map((a) => a.kind) }).toEqual({
        name,
        fields,
        kinds,
      })
    }
  })

  test('a draft plan is activated; an inactive one is left alone and noted', () => {
    const inactive = sub({
      basePlans: [plan('monthly', 'P1M', '4.99'), plan('yearly', 'P1Y', '39.99', { state: 'INACTIVE' })],
    })
    const r = diffPlaySubscriptions([desired()], observed([inactive]))
    expect(r.actions).toEqual([])
    expect(r.rows[0]!.notes).toContain('base plan yearly is inactive (left alone)')
  })

  test('extras: subscriptions, base plans and offers not in the file are noted, never planned', () => {
    const r = diffPlaySubscriptions(
      [desired()],
      observed(
        [
          sub({
            basePlans: [
              plan('monthly', 'P1M', '4.99'),
              plan('yearly', 'P1Y', '39.99'),
              plan('weekly', 'P1W', '1'),
            ],
          }),
          sub({ productId: 'old' }),
        ],
        { 'pro/monthly': [trialOffer(), trialOffer({ offerId: 'winback' })] },
      ),
    )
    expect(r.actions).toEqual([])
    expect(r.rows[0]!.notes).toEqual([
      'base plan weekly is not in the file (kept)',
      'offer monthly/winback is not in the file (kept)',
    ])
    expect(r.rows[1]).toMatchObject({ id: 'old', sync: 'extra' })
    expect(
      diffPlaySubscriptions([desired()], observed([sub({ productId: 'old' })]), { extras: false }).rows,
    ).toHaveLength(1)
  })

  test('a changed billing period is an error action that stops the rest', () => {
    const r = diffPlaySubscriptions(
      [desired()],
      observed([sub({ basePlans: [plan('monthly', 'P3M', '4.99'), plan('yearly', 'P1Y', '39.99')] })]),
    )
    expect(r.actions[0]!.kind).toBe('error')
    expect(r.actions[0]!.summary).toContain('monthly bills every P3M in Play and the file says P1M')
  })

  test('another backwards-compatible base plan blocks with an explanation', () => {
    const o = sub({
      basePlans: [
        plan('monthly', 'P1M', '4.99', {
          autoRenewingBasePlanType: { billingPeriodDuration: 'P1M', legacyCompatible: false },
        }),
        plan('yearly', 'P1Y', '39.99', {
          autoRenewingBasePlanType: { billingPeriodDuration: 'P1Y', legacyCompatible: true },
        }),
      ],
    })
    const r = diffPlaySubscriptions([desired()], observed([o]))
    expect(r.actions[0]!.kind).toBe('error')
    expect(r.actions[0]!.summary).toContain('yearly is the backwards-compatible one')
  })

  test('price: without allowPriceChange a row and a note, with it an upsert for that plan only', () => {
    const o = observed([sub()])
    const changed = desired({
      basePlans: [
        { basePlanId: 'monthly', period: 'P1M', price: '4.99', trial: 'P1W', legacyCompatible: true },
        { basePlanId: 'yearly', period: 'P1Y', price: '49.99', legacyCompatible: false },
      ],
    })
    const without = diffPlaySubscriptions([changed], o)
    expect(without.actions).toEqual([])
    expect(without.rows[0]).toMatchObject({ sync: 'differs', fields: ['yearly: price'] })
    expect(without.rows[0]!.notes![0]).toContain('needs --allow-price-change; new subscribers only')
    const withIt = diffPlaySubscriptions([changed], o, { extras: true, allowPriceChange: true })
    expect(withIt.actions.map((a) => a.kind)).toEqual(['upsert'])
    expect(withIt.actions[0]!.payload).toEqual({ convertPlans: ['yearly'] })
  })

  test('trial: created when the plan has none, never replaced when it differs', () => {
    const none = diffPlaySubscriptions([desired()], observed([sub()], {}))
    expect(none.rows[0]!.fields).toEqual(['monthly: trial'])
    expect(none.actions.map((a) => a.kind)).toEqual(['trial', 'activate-offer'])
    const longer = diffPlaySubscriptions(
      [desired()],
      observed([sub()], {
        'pro/monthly': [
          trialOffer({ phases: [{ duration: 'P1M', regionalConfigs: [{ regionCode: 'US', free: {} }] }] }),
        ],
      }),
    )
    expect(longer.actions).toEqual([])
    expect(longer.rows[0]).toMatchObject({ sync: 'differs', fields: ['monthly: trial'] })
    expect(longer.rows[0]!.notes).toContain('monthly: trial differs; change it in Play Console')
    const paid = diffPlaySubscriptions(
      [desired()],
      observed([sub()], {
        'pro/monthly': [
          trialOffer({
            phases: [{ duration: 'P1W', regionalConfigs: [{ regionCode: 'US', price: toMoney('1') }] }],
          }),
        ],
      }),
    )
    expect(paid.actions).toEqual([])
    expect(paid.rows[0]!.fields).toEqual(['monthly: trial'])
    const draft = diffPlaySubscriptions(
      [desired()],
      observed([sub()], { 'pro/monthly': [trialOffer({ state: 'DRAFT' })] }),
    )
    expect(draft.actions.map((a) => a.kind)).toEqual(['activate-offer'])
  })
})

describe('play subscriptions adapter against the fake', () => {
  let fakes: Fakes
  beforeEach(() => {
    fakes = startFakes()
  })
  afterEach(() => fakes.stop())

  const adapter = (allowPriceChange = false) =>
    playSubscriptionsAdapter(
      createClient({
        store: 'play',
        base: fakes.env().KIT_PLAY_API_URL,
        token: async () => 'ya29.fake-token',
        retryMs: 0,
      }),
      { packageName: 'app.example', allowPriceChange },
    )

  async function sync(list: PlaySubscriptionDesired[], allowPriceChange = false) {
    const a = adapter(allowPriceChange)
    const plan = a.diff(list, await a.observe(list)).actions
    const failures: string[] = []
    const failed = new Set<string>()
    for (const action of plan) {
      if (failed.has(action.id)) continue
      try {
        await a.apply(action)
      } catch (e) {
        failed.add(action.id)
        failures.push(`${action.id}: ${(e as Error).message}`)
      }
    }
    return { plan, failures }
  }

  const idle = async (list: PlaySubscriptionDesired[]) => {
    const a = adapter()
    return a.diff(list, await a.observe(list))
  }

  function expectNothingDestructive() {
    const bad = fakes.log.filter(
      (r) => r.method === 'DELETE' || /deactivate|migratePrices|batchDelete/.test(r.path),
    )
    expect(bad).toEqual([])
  }

  test('creates everything, activates, then plans nothing even after FX moves', async () => {
    const list = [desired(), desired({ productId: 'team', basePlans: [desired().basePlans[1]!] })]
    const r = await sync(list)
    expect(r.failures).toEqual([])
    const patch = fakes.log.find((x) => x.method === 'PATCH' && x.path.endsWith('subscriptions/pro'))!
    expect(patch.path).toBe('applications/app.example/subscriptions/pro')
    expect(Object.fromEntries(patch.query)).toEqual({
      allowMissing: 'true',
      updateMask: 'listings,basePlans',
      'regionsVersion.version': '2026/01',
    })
    expect(patch.body).toMatchObject({
      packageName: 'app.example',
      productId: 'pro',
      listings: [{ languageCode: 'en-US', title: 'Pro', description: 'Everything.', benefits: ['A', 'B'] }],
      basePlans: [
        {
          basePlanId: 'monthly',
          autoRenewingBasePlanType: { billingPeriodDuration: 'P1M', legacyCompatible: true },
          otherRegionsConfig: { usdPrice: toMoney('4.99'), newSubscriberAvailability: true },
        },
        { basePlanId: 'yearly', autoRenewingBasePlanType: { billingPeriodDuration: 'P1Y' } },
      ],
    })
    const body = patch.body as { basePlans: { autoRenewingBasePlanType: { legacyCompatible?: boolean } }[] }
    expect(body.basePlans[1]!.autoRenewingBasePlanType.legacyCompatible).toBeUndefined()
    const offer = fakes.log.find((x) => x.method === 'PATCH' && x.path.endsWith('/offers/free-trial'))!
    expect(offer.path).toBe('applications/app.example/subscriptions/pro/basePlans/monthly/offers/free-trial')
    expect(offer.body).toMatchObject({
      offerId: 'free-trial',
      phases: [{ duration: 'P1W', recurrenceCount: 1 }],
      targeting: { acquisitionRule: { scope: { thisSubscription: {} } } },
    })
    expect([...fakes.play.subscriptions.keys()]).toEqual(['pro', 'team'])
    expect(fakes.play.offers.get('pro/monthly/free-trial')!.state).toBe('ACTIVE')

    fakes.play.fx = 1.4
    const again = await idle(list)
    expect(again.actions).toEqual([])
    expect(again.rows.map((x) => x.sync)).toEqual(['in-sync', 'in-sync'])
    expectNothingDestructive()
    expect(
      fakes
        .writes('play')
        .every(
          (w) =>
            w.method === 'PATCH' || w.path.includes('activate') || w.path.includes('convertRegionPrices'),
        ),
    ).toBe(true)
  })

  test('a changed price is applied only with allowPriceChange, keeps other plans and never migrates', async () => {
    await sync([desired()])
    const changed = desired({
      basePlans: [desired().basePlans[0]!, { ...desired().basePlans[1]!, price: '49.99' }],
    })
    const before = fakes.log.length
    const none = await sync([changed])
    expect(none.plan).toEqual([])
    expect(fakes.log.length).toBeGreaterThan(before)
    expect((await idle([changed])).rows[0]!.fields).toEqual(['yearly: price'])
    const r = await sync([changed], true)
    expect(r.failures).toEqual([])
    expect((await idle([changed])).actions).toEqual([])
    expectNothingDestructive()
  })

  test('base plans and listings the file does not own are kept in the PATCH', async () => {
    fakes.play.seedSubscription('pro', {
      title: 'Old',
      description: 'Everything.',
      benefits: ['A', 'B'],
      plans: [
        { id: 'monthly', period: 'P1M', price: '4.99', legacy: true },
        { id: 'yearly', period: 'P1Y', price: '39.99' },
        { id: 'weekly', period: 'P1W', price: '1.99', state: 'INACTIVE' },
      ],
    })
    ;(fakes.play.subscriptions.get('pro')!.listings as object[]).push({
      languageCode: 'de-DE',
      title: 'Pro',
      description: 'x',
      benefits: [],
    })
    fakes.play.seedOffer('pro', 'monthly', { duration: 'P1W' })
    const r = await sync([desired()])
    expect(r.failures).toEqual([])
    const patch = fakes.log.find((x) => x.method === 'PATCH')!.body as {
      listings: { languageCode: string }[]
      basePlans: { basePlanId: string; state?: string }[]
    }
    expect(patch.listings.map((l) => l.languageCode)).toEqual(['en-US', 'de-DE'])
    expect(patch.basePlans.map((p) => p.basePlanId)).toEqual(['monthly', 'yearly', 'weekly'])
    expect(patch.basePlans.every((p) => p.state === undefined)).toBe(true)
    expect(fakes.play.subscriptions.get('pro')!.basePlans).toHaveLength(3)
    expect(fakes.writes('play').filter((w) => w.path.includes('offers'))).toEqual([])
    expectNothingDestructive()
  })

  test('a differing trial is never written', async () => {
    fakes.play.seedSubscription('pro', {
      title: 'Pro',
      description: 'Everything.',
      benefits: ['A', 'B'],
      plans: [
        { id: 'monthly', period: 'P1M', price: '4.99', legacy: true },
        { id: 'yearly', period: 'P1Y', price: '39.99' },
      ],
    })
    fakes.play.seedOffer('pro', 'monthly', { duration: 'P1M' })
    const r = await sync([desired()])
    expect(r.plan).toEqual([])
    expect(fakes.writes('play')).toEqual([])
  })

  test('a Play that refuses base plans on create gets the two-step fallback', async () => {
    fakes.play.refuseBasePlansOnCreate = true
    const r = await sync([desired()])
    expect(r.failures).toEqual([])
    const patches = fakes.log.filter((x) => x.method === 'PATCH' && x.path.endsWith('subscriptions/pro'))
    expect(patches.map((p) => p.query.get('updateMask'))).toEqual([
      'listings,basePlans',
      'listings',
      'listings,basePlans',
    ])
    expect((await idle([desired()])).actions).toEqual([])
  })

  test('billing preconditions get the hint and stop that subscription', async () => {
    fakes.play.noBilling = true
    const r = await sync([desired()])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('kit release android --track internal')
    expect(
      fakes.log.filter((x) => x.method === 'PATCH' && x.path.endsWith('subscriptions/pro')),
    ).toHaveLength(1)
  })

  test('a 500 on PATCH fails that subscription and the rest go on', async () => {
    fakes.play.failSubPatch.add('pro')
    const r = await sync([desired(), desired({ productId: 'team' })])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('HTTP 500')
    expect(fakes.play.subscriptions.has('team')).toBe(true)
  })

  test('observe pages the list and an unknown package is a store-level error', async () => {
    for (const id of ['a', 'b', 'c'])
      fakes.play.seedSubscription(id, {
        title: id,
        description: id,
        plans: [{ id: 'monthly', period: 'P1M', price: '1.00' }],
      })
    const o = await adapter().observe([])
    expect(o.subscriptions.map((s) => s.productId)).toEqual(['a', 'b', 'c'])
    fakes.play.packageName = 'other.app'
    await expect(adapter().observe([desired()])).rejects.toThrow('Google Play has no app app.example')
  })
})
