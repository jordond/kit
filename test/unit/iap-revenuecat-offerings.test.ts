import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createClient } from '../../src/lib/iap/http'
import type { RcDesired, RcOfferingDesired } from '../../src/lib/iap/model'
import { revenuecatAdapter } from '../../src/lib/iap/revenuecat'
import {
  diffRevenuecatOfferings,
  type RcOfferingsObserved,
  revenuecatOfferingsAdapter,
} from '../../src/lib/iap/revenuecat-offerings'
import type { Action, StoreAdapter } from '../../src/lib/iap/types'
import { type Fakes, startFakes } from '../helpers/iap-fakes'

const products: RcDesired[] = [
  {
    id: 'pro:monthly',
    type: 'subscription',
    displayName: 'Pro (monthly)',
    entitlement: 'pro',
    entitlementName: 'Pro',
    apple: 'pro_monthly',
    play: 'pro:monthly',
  },
  {
    id: 'lifetime',
    type: 'non_consumable',
    displayName: 'Lifetime',
    entitlement: 'pro',
    entitlementName: 'Pro',
    apple: 'lifetime',
    play: 'lifetime',
  },
]

const offering = (over: Partial<RcOfferingDesired> = {}): RcOfferingDesired => ({
  lookupKey: 'default',
  displayName: 'Default',
  current: true,
  packages: [
    { lookupKey: '$rc_monthly', displayName: 'Monthly', position: 1, product: 'pro:monthly' },
    { lookupKey: 'lifetime', displayName: 'Lifetime', position: 2, product: 'lifetime' },
  ],
  ...over,
})

const prod = (id: string, app: string, storeId: string) => ({
  id,
  store_identifier: storeId,
  type: 'subscription',
  state: 'active',
  app_id: app,
})

const pk = (id: string, key: string, position: number, held: ReturnType<typeof prod>[], over = {}) => ({
  id,
  lookup_key: key,
  display_name: key === '$rc_monthly' ? 'Monthly' : 'Lifetime',
  position,
  state: 'active',
  products: held,
  ...over,
})

const inSync = (): RcOfferingsObserved => ({
  projectId: 'p',
  apps: { apple: 'app_ios', play: 'app_play' },
  offerings: [
    { id: 'o1', lookup_key: 'default', display_name: 'Default', is_current: true, state: 'active' },
  ],
  packages: {
    default: [
      pk('k1', '$rc_monthly', 1, [prod('a', 'app_ios', 'pro_monthly'), prod('b', 'app_play', 'pro:monthly')]),
      pk('k2', 'lifetime', 2, [prod('c', 'app_ios', 'lifetime'), prod('d', 'app_play', 'lifetime')]),
    ],
  },
})

const kinds = (d: { actions: { kind: string }[] }) => d.actions.map((a) => a.kind)

describe('diffRevenuecatOfferings', () => {
  test('missing offering: create, packages, attach, current in order', () => {
    const empty: RcOfferingsObserved = { ...inSync(), offerings: [], packages: {} }
    const d = diffRevenuecatOfferings([offering()], empty, products)
    expect(kinds(d)).toEqual(['offering', 'package', 'attach', 'package', 'attach', 'current'])
    expect(d.actions.every((a) => a.id === 'offering/default')).toBe(true)
    expect(d.rows).toEqual([
      { store: 'revenuecat', id: 'offering/default', sync: 'missing', storeState: 'not created', notes: [] },
    ])
    expect(d.actions[2]!.payload).toMatchObject({ stores: ['apple', 'play'] })
  })

  test('in sync', () => {
    const d = diffRevenuecatOfferings([offering()], inSync(), products)
    expect(d.actions).toEqual([])
    expect(d.rows[0]).toMatchObject({ sync: 'in-sync', storeState: 'current, 2 package(s)', notes: [] })
  })

  test('renamed offering and package', () => {
    const o = inSync()
    o.offerings[0]!.display_name = 'Old'
    o.packages.default![0]!.display_name = 'Old'
    const d = diffRevenuecatOfferings([offering()], o, products)
    expect(kinds(d)).toEqual(['rename', 'package-update'])
    expect(d.rows[0]).toMatchObject({ sync: 'differs', fields: ['name', 'package $rc_monthly'] })
    expect(d.actions[1]!.payload).toEqual({
      offering: 'default',
      package: '$rc_monthly',
      display_name: 'Monthly',
    })
  })

  test('position', () => {
    const o = inSync()
    o.packages.default![1]!.position = 5
    const d = diffRevenuecatOfferings([offering()], o, products)
    expect(d.actions[0]).toMatchObject({
      kind: 'package-update',
      payload: { package: 'lifetime', position: 2 },
    })
  })

  test('current differs', () => {
    const o = inSync()
    o.offerings[0]!.is_current = false
    const d = diffRevenuecatOfferings([offering()], o, products)
    expect(kinds(d)).toEqual(['current'])
    expect(d.rows[0]!.fields).toEqual(['current'])
    expect(diffRevenuecatOfferings([offering({ current: false })], o, products).actions).toEqual([])
  })

  test('extra offering only with extras', () => {
    const o = inSync()
    o.offerings.push({ id: 'o2', lookup_key: 'old', display_name: 'Old', is_current: false, state: 'active' })
    expect(diffRevenuecatOfferings([offering()], o, products).rows[1]).toMatchObject({
      id: 'offering/old',
      sync: 'extra',
    })
    expect(diffRevenuecatOfferings([offering()], o, products, { extras: false }).rows).toHaveLength(1)
  })

  test('extra package is a note and kept', () => {
    const o = inSync()
    o.packages.default!.push(pk('k3', 'weekly', 3, []))
    const d = diffRevenuecatOfferings([offering()], o, products)
    expect(d.actions).toEqual([])
    expect(d.rows[0]!.notes).toEqual(['package(s) not in the file (kept): weekly'])
  })

  test('a foreign product on a package is differs, never detached or doubled', () => {
    const o = inSync()
    o.packages.default![0]!.products = [
      prod('z', 'app_ios', 'other_sku'),
      prod('b', 'app_play', 'pro:monthly'),
    ]
    const d = diffRevenuecatOfferings([offering()], o, products)
    expect(d.actions).toEqual([])
    expect(d.rows[0]).toMatchObject({ sync: 'differs', fields: ['package $rc_monthly'] })
    expect(d.rows[0]!.notes![0]).toContain('holds other_sku for App Store, the file says pro_monthly')
  })

  test('a package missing one store product attaches only that store', () => {
    const o = inSync()
    o.packages.default![1]!.products = [prod('c', 'app_ios', 'lifetime')]
    const d = diffRevenuecatOfferings([offering()], o, products)
    expect(d.actions[0]).toMatchObject({ kind: 'attach', payload: { stores: ['play'] } })
  })

  test('archived offering and package fail the offering first', () => {
    const o = inSync()
    o.offerings[0]!.state = 'inactive'
    o.packages.default![0]!.state = 'inactive'
    const d = diffRevenuecatOfferings([offering()], o, products)
    expect(d.actions).toHaveLength(1)
    expect(d.actions[0]!.kind).toBe('error')
    expect(d.actions[0]!.summary).toContain('offering default is archived: unarchive it in RevenueCat')
    expect(d.actions[0]!.summary).toContain('package $rc_monthly is archived')
  })

  test('a package product not in the file is an error', () => {
    const d = diffRevenuecatOfferings([offering()], inSync(), [products[0]!])
    expect(d.actions[0]!.summary).toContain('product lifetime is not in the file')
  })
})

describe('revenuecat offerings adapter against the fake', () => {
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
  const targets = { projectId: 'projd2d1fc4a', bundleId: 'app.example', packageName: 'app.example' }
  const phase1 = () => revenuecatAdapter(client(), targets)
  const offerings = () => revenuecatOfferingsAdapter(client(), { ...targets, products })

  async function run<D, O>(a: StoreAdapter<D, O, Action>, list: D[]) {
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

  test('subscription products reach RevenueCat with the Play sub:plan identifier and the entitlement', async () => {
    const r = await run(phase1(), products)
    expect(r.failures).toEqual([])
    const created = fakes.log.filter((x) => x.method === 'POST' && x.path.endsWith('/products'))
    expect(created.map((c) => c.body)).toContainEqual({
      app_id: 'app_play',
      store_identifier: 'pro:monthly',
      type: 'subscription',
      display_name: 'Pro (monthly)',
    })
    const ent = [...fakes.rc.entitlements.values()].find((e) => e.lookup_key === 'pro')!
    const attached = [...fakes.rc.attached.get(ent.id as string)!].map((id) => fakes.rc.products.get(id)!)
    expect(attached.map((p) => `${p.app_id as string}:${p.store_identifier as string}`).sort()).toEqual([
      'app_ios:lifetime',
      'app_ios:pro_monthly',
      'app_play:lifetime',
      'app_play:pro:monthly',
    ])
  })

  test('creates everything after the products, then plans nothing and never deletes', async () => {
    await run(phase1(), products)
    const list = [offering()]
    const r = await run(offerings(), list)
    expect(r.failures).toEqual([])
    expect(r.plan.map((a) => a.kind)).toEqual([
      'offering',
      'package',
      'attach',
      'package',
      'attach',
      'current',
    ])
    const o = [...fakes.rc.offerings.values()][0]!
    expect(o).toMatchObject({ lookup_key: 'default', display_name: 'Default', is_current: true })
    const packages = [...fakes.rc.packages.values()]
    expect(packages.map((p) => [p.lookup_key, p.position])).toEqual([
      ['$rc_monthly', 1],
      ['lifetime', 2],
    ])
    const attach = fakes.log.find(
      (x) => x.path.includes('/packages/') && x.path.endsWith('/attach_products'),
    )!
    expect((attach.body as { products: unknown[] }).products).toEqual([
      { product_id: expect.any(String), eligibility_criteria: 'all' },
      { product_id: expect.any(String), eligibility_criteria: 'all' },
    ])
    for (const set of fakes.rc.packageProducts.values()) expect(set.size).toBe(2)

    const a = offerings()
    const again = a.diff(list, await a.observe(list))
    expect(again.actions).toEqual([])
    expect(again.rows.map((x) => x.sync)).toEqual(['in-sync'])
    expect(fakes.writes('rc').some((w) => /detach|archive/.test(w.path) || w.method === 'DELETE')).toBe(false)
  })

  test('attach fails with a clear message when the RevenueCat products do not exist', async () => {
    const r = await run(offerings(), [offering()])
    expect(r.failures).toHaveLength(2)
    expect(r.failures[0]).toContain('does not exist in RevenueCat yet: create the RevenueCat products first')
    expect([...fakes.rc.packageProducts.values()].every((s) => s.size === 0)).toBe(true)
  })

  test('a file without offerings makes no requests', async () => {
    const o = await offerings().observe([])
    expect(o.offerings).toEqual([])
    expect(fakes.log).toHaveLength(0)
  })

  test('a 401 names the offerings and packages scopes', async () => {
    fakes.rc.key = 'other'
    await expect(offerings().observe([offering()])).rejects.toThrow(
      /project_configuration:offerings:read_write and project_configuration:packages:read_write/,
    )
  })

  test('a foreign product on a package is reported and never replaced', async () => {
    await run(phase1(), products)
    const ios = fakes.rc.seedProduct('app_ios', 'other_sku', 'subscription', 'x')
    const off = fakes.rc.seedOffering('default', { display_name: 'Default', is_current: true })
    fakes.rc.seedPackage(off, '$rc_monthly', 1, [ios], { display_name: 'Monthly' })
    const a = offerings()
    const d = a.diff([offering()], await a.observe([offering()]))
    expect(d.rows[0]!.notes!.join(' ')).toContain('holds other_sku')
    const attaches = d.actions.filter((y) => y.kind === 'attach')
    expect(attaches.length).toBeGreaterThan(0)
    expect(attaches[0]!.payload).toMatchObject({ package: '$rc_monthly', stores: ['play'] })
  })

  test('an archived product fails the attach with the unarchive hint', async () => {
    await run(phase1(), products)
    for (const p of fakes.rc.products.values()) if (p.store_identifier === 'lifetime') p.state = 'inactive'
    const r = await run(offerings(), [offering()])
    expect(r.failures.join(' ')).toContain('is archived: unarchive it in RevenueCat')
  })
})
