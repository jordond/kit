import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createClient, createPacer } from '../../src/lib/iap/http'
import type { RcDesired } from '../../src/lib/iap/model'
import { diffRevenuecat, type RcObserved, revenuecatAdapter } from '../../src/lib/iap/revenuecat'
import { type Fakes, startFakes } from '../helpers/iap-fakes'

const desired = (over: Partial<RcDesired> = {}): RcDesired => ({
  id: 'membership_card',
  type: 'non_consumable',
  displayName: 'Membership Card',
  entitlement: 'membership',
  entitlementName: 'Membership Card',
  apple: 'membership_card',
  play: 'membership_card',
  ...over,
})

const prod = (id: string, app: string, storeId = 'membership_card', over: Record<string, unknown> = {}) => ({
  id,
  store_identifier: storeId,
  type: 'non_consumable',
  state: 'active',
  app_id: app,
  display_name: 'Membership Card',
  ...over,
})

const observed = (over: Partial<RcObserved> = {}): RcObserved => ({
  projectId: 'p',
  apps: { apple: 'app_ios', play: 'app_play' },
  products: [prod('p1', 'app_ios'), prod('p2', 'app_play')],
  entitlements: [{ id: 'e1', lookup_key: 'membership', display_name: 'Membership', state: 'active' }],
  attached: { e1: ['p1', 'p2'] },
  ...over,
})

const summaries = (d: { actions: { summary: string }[] }) => d.actions.map((a) => a.summary)

describe('diffRevenuecat', () => {
  test('missing everything: entitlement first, a product per app, one attach', () => {
    const d = diffRevenuecat([desired()], observed({ products: [], entitlements: [], attached: {} }))
    expect(summaries(d)).toEqual([
      'entitlement membership',
      'product apple',
      'product play',
      'attach to membership',
    ])
    expect(d.actions[1]!.payload).toEqual({
      store: 'apple',
      app_id: 'app_ios',
      store_identifier: 'membership_card',
      type: 'non_consumable',
      display_name: 'Membership Card',
    })
    expect(d.rows[0]).toMatchObject({ sync: 'missing', storeState: 'not attached' })
  })

  test('a shared entitlement is created once', () => {
    const d = diffRevenuecat(
      [desired(), desired({ id: 'tokens', apple: 'tokens', play: 'tokens' })],
      observed({ products: [], entitlements: [], attached: {} }),
    )
    expect(d.actions.filter((a) => a.kind === 'entitlement')).toHaveLength(1)
    expect(d.actions.filter((a) => a.kind === 'attach')).toHaveLength(2)
  })

  test('in sync', () => {
    const d = diffRevenuecat([desired()], observed())
    expect(d.actions).toEqual([])
    expect(d.rows).toEqual([
      {
        store: 'revenuecat',
        id: 'membership_card',
        sync: 'in-sync',
        storeState: 'attached to membership',
        notes: [],
      },
    ])
  })

  test('differs: name, attach, one app missing', () => {
    const renamed = diffRevenuecat([desired({ displayName: 'Card' })], observed())
    expect(renamed.rows[0]!.fields).toEqual(['display name apple', 'display name play'])
    expect(summaries(renamed)).toEqual(['rename apple', 'rename play'])
    const detached = diffRevenuecat([desired()], observed({ attached: { e1: ['p1'] } }))
    expect(detached.rows[0]!.fields).toEqual(['attach'])
    expect(detached.actions[0]!.payload).toEqual({
      lookup_key: 'membership',
      products: ['play:membership_card'],
    })
    const onlyIos = diffRevenuecat(
      [desired()],
      observed({ products: [prod('p1', 'app_ios')], attached: { e1: ['p1'] } }),
    )
    expect(summaries(onlyIos)).toEqual(['product play', 'attach to membership'])
  })

  test('a Play-only config makes no App Store products', () => {
    const d = diffRevenuecat(
      [desired({ apple: undefined })],
      observed({ apps: { play: 'app_play' }, products: [], attached: {} }),
    )
    expect(summaries(d)).toEqual(['product play', 'attach to membership'])
  })

  test('changed type, archived product or entitlement: error first, nothing detached', () => {
    const typed = diffRevenuecat([desired({ type: 'consumable' })], observed())
    expect(typed.actions[0]!.kind).toBe('error')
    expect(typed.actions[0]!.summary).toContain('is type non_consumable, the file says consumable')
    const archived = diffRevenuecat(
      [desired()],
      observed({
        products: [prod('p1', 'app_ios', 'membership_card', { state: 'inactive' }), prod('p2', 'app_play')],
      }),
    )
    expect(archived.actions[0]!.summary).toContain('archived: unarchive it in RevenueCat')
    const ent = diffRevenuecat(
      [desired()],
      observed({ entitlements: [{ id: 'e1', lookup_key: 'membership', state: 'inactive' }] }),
    )
    expect(ent.actions[0]!.summary).toContain('entitlement membership is archived')
  })

  test('extras and other attached products are reported', () => {
    const d = diffRevenuecat(
      [desired()],
      observed({
        products: [...observed().products, prod('p9', 'app_play', 'old_sku')],
        attached: { e1: ['p1', 'p2', 'p9'] },
      }),
    )
    expect(d.rows[0]!.notes).toEqual(['1 product(s) not in the file are attached to membership (kept)'])
    expect(d.rows[1]).toMatchObject({ id: 'old_sku', sync: 'extra' })
    expect(d.actions).toEqual([])
  })
})

describe('revenuecat adapter against the fake', () => {
  let fakes: Fakes
  beforeEach(() => {
    fakes = startFakes()
  })
  afterEach(() => fakes.stop())

  const adapter = (pace?: ReturnType<typeof createPacer>) =>
    revenuecatAdapter(
      createClient({
        store: 'revenuecat',
        base: fakes.env().KIT_RC_API_URL,
        token: async () => 'sk_fake_key',
        pace,
      }),
      { projectId: 'projd2d1fc4a', bundleId: 'app.example', packageName: 'app.example' },
    )

  async function sync(list: RcDesired[], pace?: ReturnType<typeof createPacer>) {
    const a = adapter(pace)
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

  test('creates products, entitlements and attaches, paced; then plans nothing', async () => {
    let now = 0
    const slept: number[] = []
    const pace = createPacer(
      1000,
      () => now,
      async (ms) => {
        slept.push(ms)
        now += ms
      },
    )
    fakes.rc.seedProduct('app_ios', 'unrelated', 'consumable', 'x')
    fakes.rc.seedProduct('app_ios', 'another', 'consumable', 'y')
    const list = [
      desired(),
      desired({
        id: 'tokens',
        type: 'consumable',
        apple: 'tokens',
        play: 'tokens',
        entitlement: 'tokens',
        entitlementName: 'Tokens',
      }),
    ]
    const r = await sync(list, pace)
    expect(r.failures).toEqual([])
    const requests = fakes.log.filter((x) => x.store === 'rc')
    expect(slept).toHaveLength(requests.length - 1)
    expect(slept.every((ms) => ms === 1000)).toBe(true)

    const create = fakes.log.find((x) => x.method === 'POST' && x.path.endsWith('/products'))!
    expect(create.body).toEqual({
      app_id: 'app_ios',
      store_identifier: 'membership_card',
      type: 'non_consumable',
      display_name: 'Membership Card',
    })
    const ent = [...fakes.rc.entitlements.values()].find((e) => e.lookup_key === 'membership')!
    expect(ent.display_name).toBe('Membership Card')
    expect(fakes.rc.attached.get(ent.id as string)!.size).toBe(2)

    const a = adapter()
    const again = a.diff(list, await a.observe(list))
    expect(again.actions).toEqual([])
    expect(again.rows.filter((x) => x.sync !== 'extra').map((x) => x.sync)).toEqual(['in-sync', 'in-sync'])
    expect(fakes.writes('rc').some((w) => /detach|archive/.test(w.path) || w.method === 'DELETE')).toBe(false)
  })

  test('pages follow next_page under the configured base', async () => {
    for (let i = 0; i < 5; i++) fakes.rc.seedProduct('app_ios', `sku_${i}`, 'consumable', `n${i}`)
    const o = await adapter().observe([desired()])
    expect(o.products).toHaveLength(5)
  })

  test('a store app not connected in RevenueCat is a store-level error', async () => {
    fakes.rc.apps = fakes.rc.apps.filter((a) => a.type !== 'play_store')
    await expect(adapter().observe([desired()])).rejects.toThrow('is missing the Play Store app app.example')
  })

  test('an archived product in the entitlement path fails that product only', async () => {
    const archived = fakes.rc.seedProduct(
      'app_ios',
      'membership_card',
      'non_consumable',
      'Membership Card',
      'inactive',
    )
    expect(archived).toBeTruthy()
    const r = await sync([
      desired(),
      desired({ id: 'tokens', apple: 'tokens', play: 'tokens', entitlement: 'tokens' }),
    ])
    expect(r.failures[0]).toContain('archived: unarchive it in RevenueCat')
    expect([...fakes.rc.products.values()].some((p) => p.store_identifier === 'tokens')).toBe(true)
  })
})
