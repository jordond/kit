import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createClient } from '../../src/lib/iap/http'
import type { PlayDesired } from '../../src/lib/iap/model'
import { diffPlay, type PlayObserved, playAdapter, toMoney } from '../../src/lib/iap/play'
import { type Fakes, startFakes } from '../helpers/iap-fakes'

const desired = (over: Partial<PlayDesired> = {}): PlayDesired => ({
  productId: 'membership_card',
  purchaseOptionId: 'buy',
  listings: { 'en-US': { title: 'Membership Card', description: 'Unlimited shelf.' } },
  price: '4.99',
  scheduled: [],
  ...over,
})

const option = (over: Record<string, unknown> = {}) => ({
  purchaseOptionId: 'buy',
  state: 'ACTIVE',
  buyOption: { legacyCompatible: true, multiQuantityEnabled: false },
  regionalPricingAndAvailabilityConfigs: [
    { regionCode: 'US', price: toMoney('4.99'), availability: 'AVAILABLE' },
    { regionCode: 'DE', price: toMoney('4.79', 'EUR'), availability: 'AVAILABLE' },
  ],
  ...over,
})

const observed = (products: PlayObserved['products']): PlayObserved => ({
  packageName: 'app.example',
  products,
})
const product = (over: Record<string, unknown> = {}) => ({
  productId: 'membership_card',
  listings: [{ languageCode: 'en-US', title: 'Membership Card', description: 'Unlimited shelf.' }],
  purchaseOptions: [option()],
  ...over,
})

describe('diffPlay', () => {
  test('missing: upsert then activate', () => {
    const d = diffPlay([desired({ scheduled: [{ from: '2027-02-01', price: '7.99' }] })], observed([]))
    expect(d.actions.map((a) => `${a.kind}: ${a.summary}`)).toEqual([
      'upsert: create · price 4.99 US (+ converted regions)',
      'activate: activate buy',
    ])
    expect(d.rows[0]).toMatchObject({
      sync: 'missing',
      notes: ['Play moves to 7.99 on the first sync on or after 2027-02-01'],
    })
  })

  test('in sync, regional prices moved by FX are not drift', () => {
    const fx = option({
      regionalPricingAndAvailabilityConfigs: [
        { regionCode: 'US', price: { currencyCode: 'USD', units: '4', nanos: 990000000 } },
        { regionCode: 'DE', price: toMoney('5.29', 'EUR') },
      ],
    })
    const d = diffPlay([desired()], observed([product({ purchaseOptions: [fx] })]))
    expect(d.actions).toEqual([])
    expect(d.rows[0]).toMatchObject({ sync: 'in-sync', storeState: 'ACTIVE' })
  })

  test('differs: listing, price, legacy flag, missing option, state', () => {
    const cases: [Record<string, unknown>, Partial<PlayDesired>, string[], string[]][] = [
      [
        { listings: [{ languageCode: 'en-US', title: 'Old', description: 'Unlimited shelf.' }] },
        {},
        ['listing en-US'],
        ['upsert'],
      ],
      [
        {},
        { listings: { ...desired().listings, 'fr-FR': { title: 'Carte', description: 'Tout.' } } },
        ['listing fr-FR'],
        ['upsert'],
      ],
      [{}, { price: '5.99' }, ['price'], ['upsert']],
      [
        { purchaseOptions: [option({ buyOption: { legacyCompatible: false } })] },
        {},
        ['legacyCompatible'],
        ['upsert'],
      ],
      [{ purchaseOptions: [option({ state: 'DRAFT' })] }, {}, ['state'], ['activate']],
      [
        { purchaseOptions: [option({ purchaseOptionId: 'other', buyOption: {} })] },
        {},
        ['purchase option buy', 'state'],
        ['upsert', 'activate'],
      ],
    ]
    for (const [o, d, fields, kinds] of cases) {
      const r = diffPlay([desired(d)], observed([product(o)]))
      expect({ fields: r.rows[0]!.fields, kinds: r.actions.map((a) => a.kind) }).toEqual({ fields, kinds })
    }
    const priced = diffPlay([desired({ price: '5.99' })], observed([product()]))
    expect(priced.actions[0]!.payload).toEqual({ convert: true })
    const listed = diffPlay(
      [desired({ listings: { 'en-US': { title: 'New', description: 'x' } } })],
      observed([product()]),
    )
    expect(listed.actions[0]!.payload).toEqual({ convert: false })
  })

  test('another backwards-compatible option blocks the product with an explanation', () => {
    const r = diffPlay(
      [desired()],
      observed([
        product({
          purchaseOptions: [
            option({ buyOption: { legacyCompatible: false } }),
            option({ purchaseOptionId: 'legacy' }),
          ],
        }),
      ]),
    )
    expect(r.actions[0]!.kind).toBe('error')
    expect(r.actions[0]!.summary).toContain('legacy is the backwards-compatible one')
  })

  test('extras and other purchase options are noted, never touched', () => {
    const r = diffPlay(
      [desired()],
      observed([
        product({ purchaseOptions: [option(), option({ purchaseOptionId: 'rent', buyOption: undefined })] }),
        product({ productId: 'old' }),
      ]),
    )
    expect(r.rows[0]!.notes).toContain('purchase option rent is not in the file (kept)')
    expect(r.rows[1]).toMatchObject({ id: 'old', sync: 'extra' })
    expect(r.actions).toEqual([])
  })
})

describe('play adapter against the fake', () => {
  let fakes: Fakes
  beforeEach(() => {
    fakes = startFakes()
  })
  afterEach(() => fakes.stop())

  const adapter = () =>
    playAdapter(
      createClient({
        store: 'play',
        base: fakes.env().KIT_PLAY_API_URL,
        token: async () => 'ya29.fake-token',
        retryMs: 0,
      }),
      { packageName: 'app.example' },
    )

  async function sync(list: PlayDesired[]) {
    const a = adapter()
    const o = await a.observe(list)
    const plan = a.diff(list, o).actions
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

  test('creates on the lowercase path with every required parameter, activates, then plans nothing', async () => {
    const list = [desired(), desired({ productId: 'tokens_10', price: '0.99' })]
    const r = await sync(list)
    expect(r.failures).toEqual([])
    const patch = fakes.log.find((x) => x.method === 'PATCH')!
    expect(patch.path).toBe('applications/app.example/onetimeproducts/membership_card')
    expect(Object.fromEntries(patch.query)).toEqual({
      allowMissing: 'true',
      updateMask: 'listings,purchaseOptions',
      'regionsVersion.version': '2026/01',
    })
    expect(patch.body).toMatchObject({
      packageName: 'app.example',
      productId: 'membership_card',
      listings: [{ languageCode: 'en-US', title: 'Membership Card', description: 'Unlimited shelf.' }],
      purchaseOptions: [
        {
          purchaseOptionId: 'buy',
          buyOption: { legacyCompatible: true, multiQuantityEnabled: false },
          newRegionsConfig: {
            usdPrice: toMoney('4.99'),
            eurPrice: toMoney('4.99', 'EUR'),
            availability: 'AVAILABLE',
          },
        },
      ],
    })
    const activate = fakes.log.find((x) => x.path.endsWith('purchaseOptions:batchUpdateStates'))!
    expect(activate.path).toBe(
      'applications/app.example/oneTimeProducts/membership_card/purchaseOptions:batchUpdateStates',
    )
    expect(activate.body).toEqual({
      requests: [
        {
          activatePurchaseOptionRequest: {
            packageName: 'app.example',
            productId: 'membership_card',
            purchaseOptionId: 'buy',
          },
        },
      ],
    })

    fakes.play.fx = 1.3 // exchange rates move; the next run must still be idle
    const a = adapter()
    const again = a.diff(list, await a.observe(list))
    expect(again.actions).toEqual([])
    expect(again.rows.map((x) => `${x.sync} ${x.storeState}`)).toEqual(['in-sync ACTIVE', 'in-sync ACTIVE'])
  })

  test('a listing change resends the observed regional prices and keeps other options and listings', async () => {
    fakes.play.seed('membership_card', { title: 'Old', description: 'Unlimited shelf.', price: '4.99' })
    const p = fakes.play.products.get('membership_card')!
    ;(p.listings as object[]).push({ languageCode: 'de-DE', title: 'Karte', description: 'x' })
    ;(p.purchaseOptions as object[]).push({
      purchaseOptionId: 'rent',
      state: 'ACTIVE',
      rentOption: { rentalPeriod: 'P7D' },
    })
    const before = JSON.stringify(
      (p.purchaseOptions as { regionalPricingAndAvailabilityConfigs: unknown }[])[0]!
        .regionalPricingAndAvailabilityConfigs,
    )
    fakes.play.fx = 2
    const r = await sync([desired()])
    expect(r.failures).toEqual([])
    const patch = fakes.log.find((x) => x.method === 'PATCH')!.body as {
      listings: { languageCode: string }[]
      purchaseOptions: {
        purchaseOptionId: string
        state?: string
        regionalPricingAndAvailabilityConfigs?: unknown
      }[]
    }
    expect(patch.listings.map((l) => l.languageCode)).toEqual(['en-US', 'de-DE'])
    expect(patch.purchaseOptions.map((o) => o.purchaseOptionId)).toEqual(['buy', 'rent'])
    expect(patch.purchaseOptions.every((o) => o.state === undefined)).toBe(true)
    expect(JSON.stringify(patch.purchaseOptions[0]!.regionalPricingAndAvailabilityConfigs)).toBe(before)
    // One convert call, for the regions version only.
    expect(fakes.play.convertCalls).toBe(1)
  })

  test('a 500 on PATCH is retried once, then that product fails and the rest go on', async () => {
    fakes.play.failPatch.add('membership_card')
    const r = await sync([desired(), desired({ productId: 'tokens_10' })])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('HTTP 500 INTERNAL')
    expect(fakes.log.filter((x) => x.method === 'PATCH' && x.path.endsWith('/membership_card'))).toHaveLength(
      2,
    )
    expect(fakes.play.products.has('tokens_10')).toBe(true)
  })

  test('an unknown package is a store-level error', async () => {
    fakes.play.packageName = 'other.app'
    await expect(adapter().observe([desired()])).rejects.toThrow('Google Play has no app app.example')
  })
})
