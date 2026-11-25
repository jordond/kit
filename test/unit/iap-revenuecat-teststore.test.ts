import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createClient } from '../../src/lib/iap/http'
import type { RcDesired } from '../../src/lib/iap/model'
import { diffRevenuecat, type RcObserved, revenuecatAdapter } from '../../src/lib/iap/revenuecat'
import { revenuecatOfferingsAdapter } from '../../src/lib/iap/revenuecat-offerings'
import { type Fakes, startFakes } from '../helpers/iap-fakes'

const desired = (over: Partial<RcDesired> = {}): RcDesired => ({
  id: 'membership_card',
  type: 'non_consumable',
  displayName: 'Membership Card',
  entitlement: 'membership',
  entitlementName: 'Membership Card',
  apple: 'membership_card',
  play: 'membership_card',
  test: 'membership_card',
  testTitle: 'Membership Card',
  ...over,
})

const sub = (over: Partial<RcDesired> = {}): RcDesired =>
  desired({
    id: 'pro:monthly',
    type: 'subscription',
    displayName: 'Pro (monthly)',
    entitlement: 'pro',
    entitlementName: 'Pro',
    apple: 'pro_monthly',
    play: 'pro:monthly',
    test: 'pro_monthly',
    testTitle: 'Pro (monthly)',
    testDuration: 'P1M',
    ...over,
  })

describe('revenuecat Test Store', () => {
  let fakes: Fakes
  beforeEach(() => {
    fakes = startFakes()
  })
  afterEach(() => fakes.stop())

  const client = () =>
    createClient({
      store: 'revenuecat',
      base: fakes.env().KIT_RC_API_URL,
      token: async () => 'sk_fake_key',
    })
  const targets = (testStore: boolean) => ({
    projectId: 'projd2d1fc4a',
    bundleId: 'app.example',
    packageName: 'app.example',
    testStore,
  })
  const adapter = (testStore: boolean) => revenuecatAdapter(client(), targets(testStore))

  async function sync(list: RcDesired[], testStore = true) {
    const a = adapter(testStore)
    const plan = a.diff(list, await a.observe(list)).actions
    const failures: string[] = []
    for (const action of plan) {
      try {
        await a.apply(action)
      } catch (e) {
        failures.push(`${action.id}: ${(e as Error).message}`)
      }
    }
    return { plan, failures }
  }

  const testProducts = () => [...fakes.rc.products.values()].filter((p) => p.app_id === 'app_test')

  test('off: no Test Store rows and no Test Store requests', async () => {
    const r = await sync([desired()], false)
    expect(r.failures).toEqual([])
    expect(testProducts()).toEqual([])
    expect(r.plan.map((a) => a.summary).join()).not.toContain('test')
    expect(fakes.log.some((x) => JSON.stringify(x.body ?? '').includes('app_test'))).toBe(false)
  })

  test('on: creates with title and duration, attaches them, then plans nothing', async () => {
    const list = [desired(), sub()]
    const r = await sync(list)
    expect(r.failures).toEqual([])
    expect(r.plan.find((a) => a.summary.startsWith('product test store'))!.summary).toContain(
      'price: set it in RevenueCat; the API takes none',
    )
    const creates = fakes.log
      .filter((x) => x.method === 'POST' && x.path.endsWith('/products'))
      .map((x) => x.body as Record<string, unknown>)
      .filter((b) => b.app_id === 'app_test')
    expect(creates).toEqual([
      {
        app_id: 'app_test',
        store_identifier: 'membership_card',
        type: 'non_consumable',
        display_name: 'Membership Card',
        title: 'Membership Card',
      },
      {
        app_id: 'app_test',
        store_identifier: 'pro_monthly',
        type: 'subscription',
        display_name: 'Pro (monthly)',
        title: 'Pro (monthly)',
        subscription: { duration: 'P1M' },
      },
    ])
    for (const e of fakes.rc.entitlements.values()) {
      const held = [...fakes.rc.attached.get(e.id as string)!].map((id) => fakes.rc.products.get(id)!.app_id)
      expect(held).toContain('app_test')
    }
    const a = adapter(true)
    expect(a.diff(list, await a.observe(list)).actions).toEqual([])
  })

  test('an existing non_consumable Test Store product is matched, not created', async () => {
    fakes.rc.seedProduct('app_test', 'membership_card', 'non_consumable', 'Membership Card')
    const r = await sync([desired()])
    expect(r.plan.some((a) => a.kind === 'product' && a.summary.includes('test store'))).toBe(false)
    expect(testProducts()).toHaveLength(1)
  })

  test('a missing Test Store app is an error while apple and play still sync', async () => {
    fakes.rc.apps = fakes.rc.apps.filter((a) => a.type !== 'test_store')
    const r = await sync([desired()])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('Apps & providers')
    expect([...fakes.rc.products.values()].map((p) => p.app_id).sort()).toEqual(['app_ios', 'app_play'])
  })

  test('a refused create is an error for that product only', async () => {
    fakes.rc.rejectTestCreate = 'price is required'
    const r = await sync([desired(), sub()])
    expect(r.failures.filter((f) => f.includes('price is required'))).toHaveLength(2)
    // The real sync skips a failed product's remaining actions (the Test Store attach); apple and
    // play were created and attached before the refused create.
    expect([...fakes.rc.products.values()].filter((p) => p.app_id !== 'app_test')).toHaveLength(4)
    for (const set of fakes.rc.attached.values()) expect(set.size).toBe(2)
  })

  test('a period with no Test Store duration is an error for that plan only', () => {
    const observed: RcObserved = {
      projectId: 'p',
      apps: { apple: 'app_ios', play: 'app_play', test: 'app_test' },
      products: [],
      entitlements: [],
      attached: {},
    }
    const d = diffRevenuecat(
      [sub({ test: undefined, testDuration: undefined, testError: 'no duration for P2W' }), desired()],
      observed,
    )
    const errors = d.actions.filter((a) => a.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.id).toBe('pro:monthly')
    expect(errors[0]!.summary).toContain('Test Store: no duration for P2W')
  })

  test('a package attaches the Test Store product too', async () => {
    const list = [desired()]
    await sync(list)
    const a = revenuecatOfferingsAdapter(client(), { ...targets(true), products: list })
    const offerings = [
      {
        lookupKey: 'default',
        displayName: 'Default',
        current: true,
        packages: [
          { lookupKey: 'lifetime', displayName: 'Lifetime', position: 1, product: 'membership_card' },
        ],
      },
    ]
    for (const action of a.diff(offerings, await a.observe(offerings)).actions) await a.apply(action)
    const testId = testProducts()[0]!.id as string
    const sets = [...fakes.rc.packageProducts.values()]
    expect(sets).toHaveLength(1)
    expect(sets[0]!.has(testId)).toBe(true)
    expect(sets[0]!.size).toBe(3)
  })
})
