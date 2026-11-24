import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePng } from '../../src/lib/image/png'
import {
  type AppleSubGroup,
  type AppleSubPlan,
  type AppleSubscriptionsObserved,
  appleSubscriptionsAdapter,
  diffAppleSubscriptions,
} from '../../src/lib/iap/apple-subscriptions'
import { createClient } from '../../src/lib/iap/http'
import type { AppleSubscriptionDesired, AppleSubscriptionPlanDesired } from '../../src/lib/iap/model'
import { type Fakes, startFakes } from '../helpers/iap-fakes'

const TODAY = '2026-11-24'

const LOCALES = { 'en-US': { name: 'Pro', description: 'Everything unlocked.' } }

const monthly = (over: Partial<AppleSubscriptionPlanDesired> = {}): AppleSubscriptionPlanDesired => ({
  ref: 'pro:monthly',
  productId: 'app.pro.monthly',
  name: 'Pro (monthly)',
  period: 'ONE_MONTH',
  groupLevel: 2,
  price: '4.99',
  familySharable: false,
  localizations: LOCALES,
  ...over,
})
const yearly = (over: Partial<AppleSubscriptionPlanDesired> = {}): AppleSubscriptionPlanDesired => ({
  ref: 'pro:yearly',
  productId: 'app.pro.yearly',
  name: 'Pro (yearly)',
  period: 'ONE_YEAR',
  groupLevel: 1,
  price: '39.99',
  familySharable: false,
  localizations: LOCALES,
  ...over,
})
const sub = (plans: AppleSubscriptionPlanDesired[] = [yearly(), monthly()]): AppleSubscriptionDesired => ({
  id: 'pro',
  groupLocalizations: { 'en-US': 'Pro' },
  plans,
})

const obsPlan = (d: AppleSubscriptionPlanDesired, over: Partial<AppleSubPlan> = {}): AppleSubPlan => ({
  ascId: `s-${d.productId}`,
  productId: d.productId,
  name: d.name,
  period: d.period,
  groupLevel: d.groupLevel,
  familySharable: d.familySharable,
  state: 'READY_TO_SUBMIT',
  version: { id: 'v', state: 'PREPARE_FOR_SUBMISSION' },
  hasDraft: true,
  localizations: [{ id: 'l', locale: 'en-US', name: 'Pro', description: 'Everything unlocked.' }],
  prices: [{ startDate: null, endDate: null, customerPrice: d.price }],
  availability: true,
  offers: d.trial ? [{ id: 'o', mode: 'FREE_TRIAL', duration: d.trial }] : [],
  ...over,
})
const obsGroup = (plans: AppleSubPlan[], over: Partial<AppleSubGroup> = {}): AppleSubGroup => ({
  ascId: 'g1',
  referenceName: 'pro',
  version: { id: 'gv', state: 'PREPARE_FOR_SUBMISSION' },
  hasDraft: true,
  localizations: [{ id: 'gl', locale: 'en-US', name: 'Pro' }],
  plans,
  ...over,
})
const observed = (groups: AppleSubGroup[]): AppleSubscriptionsObserved => ({
  appId: 'app',
  bundleId: 'app.example',
  today: TODAY,
  groups,
})
/** Both plans in the store exactly as the file wants. */
const inSync = (d = sub()) => observed([obsGroup(d.plans.map((p) => obsPlan(p)))])
const kinds = (d: { actions: { kind: string }[] }) => d.actions.map((a) => a.kind)

describe('diffAppleSubscriptions', () => {
  test('missing: group, group localization, then every plan in Apple order', () => {
    const d = diffAppleSubscriptions(
      [
        sub([
          yearly({
            trial: 'ONE_WEEK',
            screenshot: { path: '/x.png', fileName: 'x.png', size: 3, md5: 'abc' },
          }),
          monthly(),
        ]),
      ],
      observed([]),
    )
    expect(kinds(d)).toEqual([
      'group',
      'group-localizations',
      ...['create', 'localizations', 'availability', 'price', 'trial', 'screenshot'],
      ...['create', 'localizations', 'availability', 'price'],
    ])
    expect(d.actions.every((a) => a.id === 'pro')).toBe(true)
    expect(d.actions[2]!.payload).toEqual({
      plan: 'app.pro.yearly',
      attributes: {
        name: 'Pro (yearly)',
        productId: 'app.pro.yearly',
        subscriptionPeriod: 'ONE_YEAR',
        groupLevel: 1,
        familySharable: false,
      },
    })
    expect(d.actions.map((a) => a.summary).slice(0, 8)).toEqual([
      'group',
      'group localization en-US',
      'yearly: create',
      'yearly: localization en-US',
      'yearly: availability',
      'yearly: price 39.99',
      'yearly: trial ONE_WEEK',
      'yearly: screenshot',
    ])
    expect(d.rows).toHaveLength(1)
    expect(d.rows[0]).toMatchObject({ id: 'pro', sync: 'missing' })
    expect(d.rows[0]!.notes!.join(' ')).toContain('first auto-renewable subscription ships with')
  })

  test('in sync: nothing to do', () => {
    const d = diffAppleSubscriptions([sub()], inSync())
    expect(d.actions).toEqual([])
    expect(d.rows).toEqual([
      {
        store: 'apple',
        id: 'pro',
        sync: 'in-sync',
        storeState: 'yearly READY_TO_SUBMIT · monthly READY_TO_SUBMIT',
        notes: [
          expect.stringContaining('first auto-renewable subscription'),
          'yearly: no review screenshot (App Store Connect keeps it MISSING_METADATA)',
          'monthly: no review screenshot (App Store Connect keeps it MISSING_METADATA)',
        ],
      },
    ])
  })

  test('a plan missing from an existing group is created; the row differs', () => {
    const d = diffAppleSubscriptions([sub()], observed([obsGroup([obsPlan(yearly())])]))
    expect(kinds(d)).toEqual(['create', 'localizations', 'availability', 'price'])
    expect(d.rows[0]).toMatchObject({ sync: 'differs', fields: ['monthly: missing'] })
  })

  test('differs: each field names its plan', () => {
    const want = sub([
      yearly({ name: 'Pro Annual', groupLevel: 1, reviewNote: 'Sign in with demo.', familySharable: true }),
      monthly({ localizations: { 'en-US': { name: 'Pro+', description: 'Everything unlocked.' } } }),
    ])
    const have = observed([
      obsGroup(
        [
          obsPlan(yearly(), {
            name: 'Pro (yearly)',
            reviewNote: 'old',
            familySharable: false,
            groupLevel: 3,
          }),
          obsPlan(monthly(), { availability: false }),
        ],
        { localizations: [{ id: 'gl', locale: 'en-US', name: 'Old' }] },
      ),
    ])
    const d = diffAppleSubscriptions([want], have)
    expect(d.rows[0]!.sync).toBe('differs')
    expect(d.rows[0]!.fields).toEqual([
      'group localization en-US',
      'yearly: referenceName',
      'yearly: groupLevel',
      'yearly: reviewNote',
      'yearly: familySharable',
      'monthly: localization en-US',
      'monthly: availability',
    ])
    expect(kinds(d)).toEqual(['group-localizations', 'update', 'localizations', 'availability'])
    expect(d.actions[1]!.payload).toEqual({
      plan: 'app.pro.yearly',
      attributes: {
        name: 'Pro Annual',
        groupLevel: 1,
        reviewNote: 'Sign in with demo.',
        familySharable: true,
      },
    })
  })

  test('a file without reviewNote leaves the store note alone; a non-draft version says new version', () => {
    const d = diffAppleSubscriptions(
      [sub([monthly({ localizations: { 'en-US': { name: 'New', description: 'x' } } })])],
      observed([
        obsGroup([
          obsPlan(monthly(), {
            reviewNote: 'console note',
            hasDraft: false,
            version: { id: 'v', state: 'APPROVED' },
          }),
        ]),
      ]),
    )
    expect(d.actions.map((a) => a.summary)).toEqual(['monthly: localization en-US (new version)'])
  })

  test('plans and localizations in the store but not the file are noted and kept', () => {
    const extraPlan = { ...obsPlan(yearly(), { productId: 'app.pro.weekly' }) }
    const have = obsPlan(monthly(), {
      localizations: [
        { id: 'l', locale: 'en-US', name: 'Pro', description: 'Everything unlocked.' },
        { id: 'l2', locale: 'fr-FR', name: 'Pro', description: 'Tout.' },
      ],
    })
    const d = diffAppleSubscriptions([sub([monthly()])], observed([obsGroup([have, extraPlan])]))
    expect(d.actions).toEqual([])
    expect(d.rows[0]!.notes).toContain('plan app.pro.weekly is not in the file (kept)')
    expect(d.rows[0]!.notes).toContain('monthly: localization fr-FR is not in the file (kept)')
  })

  test('extra groups are rows only with extras', () => {
    const other = obsGroup([], { ascId: 'g2', referenceName: 'legacy' })
    const have = observed([...inSync().groups, other])
    expect(diffAppleSubscriptions([sub()], have).rows.map((r) => [r.id, r.sync])).toEqual([
      ['pro', 'in-sync'],
      ['legacy', 'extra'],
    ])
    expect(diffAppleSubscriptions([sub()], have, { extras: false }).rows.map((r) => r.id)).toEqual(['pro'])
  })

  test('the period is immutable: an error action', () => {
    const d = diffAppleSubscriptions(
      [sub([monthly({ period: 'ONE_YEAR' })])],
      observed([obsGroup([obsPlan(monthly(), { period: 'ONE_MONTH' })])]),
    )
    expect(d.rows[0]).toMatchObject({ sync: 'differs', fields: ['monthly: subscriptionPeriod'] })
    expect(d.actions).toHaveLength(1)
    expect(d.actions[0]).toMatchObject({ kind: 'error', id: 'pro' })
    expect(d.actions[0]!.summary).toContain('cannot change')
  })

  test('Family Sharing true to false is an error action; false to true is an update', () => {
    const off = diffAppleSubscriptions(
      [sub([monthly({ familySharable: false })])],
      observed([obsGroup([obsPlan(monthly(), { familySharable: true })])]),
    )
    expect(off.actions).toHaveLength(1)
    expect(off.actions[0]).toMatchObject({ kind: 'error' })
    expect(off.actions[0]!.summary).toContain('Family Sharing is on')
    const on = diffAppleSubscriptions(
      [sub([monthly({ familySharable: true })])],
      observed([obsGroup([obsPlan(monthly(), { familySharable: false })])]),
    )
    expect(on.actions[0]).toMatchObject({ kind: 'update', payload: { attributes: { familySharable: true } } })
  })

  test('a product id in another group is an error, not a create', () => {
    const have = observed([
      obsGroup([], { referenceName: 'pro' }),
      obsGroup([obsPlan(monthly())], { ascId: 'g2', referenceName: 'old-group' }),
    ])
    const d = diffAppleSubscriptions([sub([monthly()])], have)
    expect(kinds(d)).toEqual(['error'])
    expect(d.actions[0]!.summary).toContain('already exists in subscription group old-group')
  })

  test('price: a changed USA price needs --allow-price-change', () => {
    const want = [sub([monthly({ price: '5.99' })])]
    const have = observed([obsGroup([obsPlan(monthly())])])
    const without = diffAppleSubscriptions(want, have)
    expect(without.actions).toEqual([])
    expect(without.rows[0]).toMatchObject({ sync: 'differs', fields: ['monthly: price'] })
    expect(without.rows[0]!.notes).toContain(
      'monthly: price 4.99 in the store, 5.99 in the file: needs --allow-price-change; existing subscribers keep their price',
    )
    const withIt = diffAppleSubscriptions(want, have, { allowPriceChange: true })
    expect(withIt.actions).toHaveLength(1)
    expect(withIt.actions[0]).toMatchObject({
      kind: 'price',
      id: 'pro',
      payload: { plan: 'app.pro.monthly', price: '5.99', preserve: true },
    })
    expect(withIt.actions[0]!.summary).toBe('monthly: price 4.99 → 5.99 (existing subscribers keep theirs)')
  })

  test('price: 4.990 equals 4.99; a decrease is called out; a plan with no price gets one without the flag', () => {
    expect(
      diffAppleSubscriptions([sub([monthly({ price: '4.990' })])], observed([obsGroup([obsPlan(monthly())])]))
        .actions,
    ).toEqual([])
    const cut = diffAppleSubscriptions(
      [sub([monthly({ price: '2.99' })])],
      observed([obsGroup([obsPlan(monthly())])]),
      { allowPriceChange: true },
    )
    expect(cut.rows[0]!.notes!.join(' ')).toContain('a price decrease reaches existing subscribers too')
    expect(cut.actions[0]!.summary).toContain('(a decrease: existing subscribers get it too)')
    const none = diffAppleSubscriptions(
      [sub([monthly()])],
      observed([obsGroup([obsPlan(monthly(), { prices: [] })])]),
    )
    expect(none.actions[0]).toMatchObject({ kind: 'price', payload: { preserve: false } })
  })

  test('trial: created only on a plan with no introductory offer; never replaced', () => {
    const create = diffAppleSubscriptions(
      [sub([yearly({ trial: 'ONE_WEEK' })])],
      observed([obsGroup([obsPlan(yearly())])]),
    )
    expect(create.actions.map((a) => a.kind)).toEqual(['trial'])
    expect(create.actions[0]!.payload).toEqual({ plan: 'app.pro.yearly', duration: 'ONE_WEEK' })

    const differs = diffAppleSubscriptions(
      [sub([yearly({ trial: 'ONE_WEEK' })])],
      observed([
        obsGroup([obsPlan(yearly(), { offers: [{ id: 'o', mode: 'FREE_TRIAL', duration: 'THREE_DAYS' }] })]),
      ]),
    )
    expect(differs.actions).toEqual([])
    expect(differs.rows[0]).toMatchObject({ sync: 'differs', fields: ['yearly: trial'] })
    expect(differs.rows[0]!.notes).toContain(
      'yearly: trial is THREE_DAYS in the store, ONE_WEEK in the file: change it in App Store Connect',
    )

    const paid = diffAppleSubscriptions(
      [sub([yearly({ trial: 'ONE_WEEK' })])],
      observed([
        obsGroup([
          obsPlan(yearly(), { offers: [{ id: 'o', mode: 'PAY_AS_YOU_GO', duration: 'ONE_MONTH' }] }),
        ]),
      ]),
    )
    expect(paid.actions).toEqual([])
    expect(paid.rows[0]!.fields).toEqual(['yearly: trial'])
  })

  test('trial: an extra trial in the store is a differs row', () => {
    const d = diffAppleSubscriptions(
      [sub([yearly()])],
      observed([
        obsGroup([obsPlan(yearly(), { offers: [{ id: 'o', mode: 'FREE_TRIAL', duration: 'ONE_WEEK' }] })]),
      ]),
    )
    expect(d.actions).toEqual([])
    expect(d.rows[0]).toMatchObject({ sync: 'differs', fields: ['yearly: trial'] })
    expect(d.rows[0]!.notes!.join(' ')).toContain('change it in App Store Connect')
  })

  test('trial: one an earlier sync left half made is finished in the missing territories only', () => {
    const want = sub([yearly({ trial: 'ONE_WEEK' })])
    const offers = ['USA', 'CAN'].map((t) => ({
      id: t,
      mode: 'FREE_TRIAL',
      duration: 'ONE_WEEK',
      territory: t,
    }))
    const state = {
      ...observed([obsGroup([obsPlan(yearly(), { offers })])]),
      territories: ['USA', 'CAN', 'FRA', 'DEU'],
    }
    const d = diffAppleSubscriptions([want], state)
    expect(d.actions.map((a) => a.payload)).toEqual([
      { plan: 'app.pro.yearly', duration: 'ONE_WEEK', territories: ['FRA', 'DEU'] },
    ])
    expect(d.rows[0]!.notes!.join(' ')).toContain('missing in 2 territories')
    // Complete: in sync. A different duration somewhere: never touched.
    expect(diffAppleSubscriptions([want], { ...state, territories: ['USA', 'CAN'] }).actions).toEqual([])
    const mixed = [{ ...offers[0]!, duration: 'THREE_DAYS' }, offers[1]!]
    expect(
      diffAppleSubscriptions([want], {
        ...observed([obsGroup([obsPlan(yearly(), { offers: mixed })])]),
        territories: ['USA', 'CAN', 'FRA'],
      }).actions,
    ).toEqual([])
  })

  test('price: prices the store lists but kit cannot read never reprice without the flag', () => {
    const unreadable = observed([obsGroup([obsPlan(monthly(), { prices: [], priceRows: 2 })])])
    const plain = diffAppleSubscriptions([sub([monthly()])], unreadable)
    expect(plain.actions).toEqual([])
    expect(plain.rows[0]!.notes!.join(' ')).toContain('no current USA price kit can read')
    const allowed = diffAppleSubscriptions([sub([monthly()])], unreadable, { allowPriceChange: true })
    expect(allowed.actions[0]).toMatchObject({ kind: 'price', payload: { preserve: true } })
    // Only a scheduled price: same rule.
    const scheduled = observed([
      obsGroup([
        obsPlan(monthly(), { prices: [{ startDate: '2027-03-01', endDate: null, customerPrice: '9.99' }] }),
      ]),
    ])
    expect(diffAppleSubscriptions([sub([monthly()])], scheduled).actions).toEqual([])
  })

  test('price: after an allowed change, the new price next to a preserved one is in sync', () => {
    for (const preserved of [true, false]) {
      const both = observed([
        obsGroup([
          obsPlan(monthly({ price: '5.99' }), {
            prices: [
              { startDate: null, endDate: null, customerPrice: '4.99', preserved },
              { startDate: null, endDate: null, customerPrice: '5.99', preserved: !preserved },
            ],
          }),
        ]),
      ])
      expect(
        diffAppleSubscriptions([sub([monthly({ price: '5.99' })])], both, { allowPriceChange: true }).actions,
      ).toEqual([])
    }
  })

  test('trial: a matching trial is in sync', () => {
    const want = sub([yearly({ trial: 'ONE_WEEK' })])
    expect(diffAppleSubscriptions([want], inSync(want)).actions).toEqual([])
  })

  test('a differing screenshot is a note, never an action', () => {
    const shot = { path: '/x.png', fileName: 'x.png', size: 3, md5: 'abc' }
    const d = diffAppleSubscriptions(
      [sub([monthly({ screenshot: shot })])],
      observed([
        obsGroup([obsPlan(monthly(), { screenshot: { id: 's', checksum: 'zzz', state: 'COMPLETE' } })]),
      ]),
    )
    expect(d.actions).toEqual([])
    expect(d.rows[0]!.fields).toEqual(['monthly: screenshot'])
    expect(d.rows[0]!.notes!.join(' ')).toContain('kit never deletes')
  })
})

describe('apple subscriptions adapter against the fake', () => {
  let fakes: Fakes
  let dir = ''
  let shot: NonNullable<AppleSubscriptionPlanDesired['screenshot']>
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-iap-apple-subs-'))
    const path = join(dir, 'review.png')
    writeFileSync(path, encodePng(4, 4, new Uint8Array(48)))
    const bytes = readFileSync(path)
    shot = {
      path,
      fileName: 'review.png',
      size: bytes.length,
      md5: createHash('md5').update(bytes).digest('hex'),
    }
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    fakes = startFakes()
  })
  afterEach(() => fakes.stop())

  const adapter = (allowPriceChange = false) =>
    appleSubscriptionsAdapter(
      createClient({ store: 'apple', base: fakes.env().KIT_ASC_API_URL, token: async () => 'jwt' }),
      { bundleId: 'app.example', allowPriceChange, today: TODAY, sleep: async () => {}, pollMs: 1 },
    )

  async function sync(list: AppleSubscriptionDesired[], allowPriceChange = false) {
    const a = adapter(allowPriceChange)
    const o = await a.observe(list)
    const plan = await a.prepare!(a.diff(list, o).actions, o)
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

  async function replan(list: AppleSubscriptionDesired[], allowPriceChange = false) {
    const a = adapter(allowPriceChange)
    return a.diff(list, await a.observe(list))
  }

  const full = () =>
    sub([
      yearly({
        trial: 'ONE_WEEK',
        screenshot: shot,
        reviewNote: 'Demo login in notes.',
        familySharable: true,
      }),
      monthly({
        localizations: {
          'en-US': { name: 'Pro', description: 'Everything unlocked.' },
          'fr-FR': { name: 'Pro', description: 'Tout.' },
        },
      }),
    ])

  const noDelete = () => expect(fakes.writes('asc').some((r) => r.method === 'DELETE')).toBe(false)

  for (const autoDraft of [false, true]) {
    test(`creates everything, then observe + diff plans nothing (draft versions auto-created: ${autoDraft})`, async () => {
      fakes.asc.autoDraftVersion = autoDraft
      const list = [full()]
      const first = await sync(list)
      expect(first.failures).toEqual([])
      expect(first.plan.map((a) => a.kind)).toEqual([
        'group',
        'group-localizations',
        ...['create', 'localizations', 'availability', 'price', 'trial', 'screenshot'],
        ...['create', 'localizations', 'availability', 'price'],
      ])

      const s = fakes.asc.subs
      const group = s.groupByName('pro')!
      expect(group.versions).toHaveLength(1)
      const y = s.byProductId('app.pro.yearly')!
      const m = s.byProductId('app.pro.monthly')!
      expect(y).toMatchObject({
        group: group.id,
        name: 'Pro (yearly)',
        subscriptionPeriod: 'ONE_YEAR',
        groupLevel: 1,
        familySharable: true,
        reviewNote: 'Demo login in notes.',
        availability: 'plan',
      })
      expect(m).toMatchObject({ subscriptionPeriod: 'ONE_MONTH', groupLevel: 2 })
      expect(y.versions).toHaveLength(1)
      expect([...s.localizations.values()].map((l) => l.locale).sort()).toEqual([
        'en-US',
        'en-US',
        'en-US',
        'fr-FR',
      ])
      expect(s.usaPrice(y.id)).toBe('39.99')
      expect(s.usaPrice(m.id)).toBe('4.99')
      expect(
        s.prices
          .get(y.id)!
          .map((p) => p.territory)
          .sort(),
      ).toEqual(['CAN', 'DEU', 'GBR', 'JPN', 'USA'])
      expect(s.prices.get(y.id)!.find((p) => p.territory === 'JPN')!.customerPrice).toBe('5998.50')
      expect([...s.offers.values()].filter((o) => o.sub === y.id)).toHaveLength(5)
      expect([...s.offers.values()].filter((o) => o.sub === m.id)).toHaveLength(0)
      expect(s.availabilities.get(y.id)!.territories).toEqual(['USA', 'CAN', 'GBR', 'DEU', 'JPN'])
      expect(fakes.asc.screenshots.get(y.screenshot!)).toMatchObject({
        checksum: shot.md5,
        state: 'COMPLETE',
        bytes: shot.size,
      })

      const again = await replan(list)
      expect(again.actions).toEqual([])
      expect(again.rows.map((r) => [r.id, r.sync, r.fields])).toEqual([['pro', 'in-sync', undefined]])
      noDelete()
    })
  }

  test('bulk price PATCH: one request with inline prices, USA last, no per-territory POST', async () => {
    const list = [sub([monthly()])]
    expect((await sync(list)).failures).toEqual([])
    const patch = fakes
      .writes('asc')
      .filter((r) => r.method === 'PATCH' && r.path.startsWith('v1/subscriptions/'))
    expect(patch).toHaveLength(1)
    const body = patch[0]!.body as {
      data: { relationships: { prices: { data: { id: string }[] } } }
      included: { id: string; type: string; attributes: Record<string, unknown>; relationships: unknown }[]
    }
    expect(body.data.relationships.prices.data.map((d) => d.id)).toEqual(body.included.map((i) => i.id))
    expect(body.included).toHaveLength(5)
    expect(body.included[0]).toMatchObject({ type: 'subscriptionPrices', attributes: { startDate: null } })
    expect(body.included.at(-1)!.relationships).toMatchObject({
      subscriptionPricePoint: { data: { id: expect.stringContaining('-USA-4.99') } },
    })
    expect(fakes.writes('asc').some((r) => r.path === 'v1/subscriptionPrices')).toBe(false)
    expect((await replan(list)).actions).toEqual([])
  })

  test('bulk price PATCH refused: one POST per territory, USA last', async () => {
    fakes.asc.subs.bulkPricePatch = false
    const list = [sub([monthly({ trial: 'ONE_WEEK' })])]
    expect((await sync(list)).failures).toEqual([])
    const posts = fakes.writes('asc').filter((r) => r.path === 'v1/subscriptionPrices')
    expect(posts).toHaveLength(5)
    const points = posts.map(
      (p) =>
        (p.body as { data: { relationships: { subscriptionPricePoint: { data: { id: string } } } } }).data
          .relationships.subscriptionPricePoint.data.id,
    )
    expect(points.at(-1)).toContain('-USA-4.99')
    expect(points.slice(0, -1).some((p) => p.includes('-USA-'))).toBe(false)
    const m = fakes.asc.subs.byProductId('app.pro.monthly')!
    expect(fakes.asc.subs.usaPrice(m.id)).toBe('4.99')
    expect(fakes.asc.subs.prices.get(m.id)).toHaveLength(5)
    expect((await replan(list)).actions).toEqual([])
    noDelete()
  })

  test('plan availability refused: falls back to the deprecated endpoint and still observes as available', async () => {
    fakes.asc.subs.planAvailability = false
    const list = [sub([monthly()])]
    expect((await sync(list)).failures).toEqual([])
    const paths = fakes.writes('asc').map((r) => r.path)
    expect(paths).toContain('v1/subscriptionPlanAvailabilities')
    expect(paths).toContain('v1/subscriptionAvailabilities')
    const m = fakes.asc.subs.byProductId('app.pro.monthly')!
    expect(m.availability).toBe('legacy')
    expect(fakes.asc.subs.usaPrice(m.id)).toBe('4.99')
    expect((await replan(list)).actions).toEqual([])
  })

  test('both fallbacks at once', async () => {
    fakes.asc.subs.planAvailability = false
    fakes.asc.subs.bulkPricePatch = false
    const list = [full()]
    expect((await sync(list)).failures).toEqual([])
    expect((await replan(list)).actions).toEqual([])
    noDelete()
  })

  test('request bodies: group, subscription, availability, trial, price', async () => {
    expect((await sync([sub([yearly({ trial: 'ONE_WEEK' })])])).failures).toEqual([])
    const body = (path: string) =>
      fakes.writes('asc').find((r) => r.path === path)!.body as Record<string, any>
    expect(body('v1/subscriptionGroups').data).toMatchObject({
      type: 'subscriptionGroups',
      attributes: { referenceName: 'pro' },
      relationships: { app: { data: { type: 'apps', id: fakes.asc.appId } } },
    })
    expect(body('v1/subscriptions').data).toMatchObject({
      type: 'subscriptions',
      attributes: { productId: 'app.pro.yearly', subscriptionPeriod: 'ONE_YEAR', groupLevel: 1 },
      relationships: { group: { data: { type: 'subscriptionGroups' } } },
    })
    expect(body('v1/subscriptionPlanAvailabilities').data).toMatchObject({
      attributes: { planType: 'UPFRONT', availableInNewTerritories: true },
    })
    expect(body('v1/subscriptionIntroductoryOffers').data).toMatchObject({
      attributes: { duration: 'ONE_WEEK', offerMode: 'FREE_TRIAL', numberOfPeriods: 1 },
    })
    expect(body('v2/subscriptionGroupLocalizations').data).toMatchObject({
      type: 'subscriptionGroupLocalizations',
      attributes: { locale: 'en-US', name: 'Pro' },
    })
    expect(body('v2/subscriptionLocalizations').data).toMatchObject({
      attributes: { locale: 'en-US', name: 'Pro', description: 'Everything unlocked.' },
      relationships: { version: { data: { type: 'subscriptionVersions' } } },
    })
  })

  test('a price change on an existing plan: refused without the flag, preserved with it', async () => {
    const g = fakes.asc.subs.seedGroup({ referenceName: 'pro', localizations: { 'en-US': 'Pro' } })
    const id = fakes.asc.subs.seedSub({
      group: g,
      productId: 'app.pro.monthly',
      name: 'Pro (monthly)',
      groupLevel: 2,
      localizations: LOCALES,
      price: '4.99',
      availability: 'plan',
    })
    const list = [sub([monthly({ price: '5.99' })])]

    const without = await sync(list)
    expect(without.plan).toEqual([])
    expect(fakes.writes('asc')).toEqual([])
    expect((await replan(list)).rows[0]).toMatchObject({ sync: 'differs', fields: ['monthly: price'] })

    const withFlag = await sync(list, true)
    expect(withFlag.failures).toEqual([])
    expect(withFlag.plan.map((a) => a.kind)).toEqual(['price'])
    expect(fakes.asc.subs.usaPrice(id)).toBe('5.99')
    expect(fakes.asc.subs.prices.get(id)!.every((p) => p.preserved)).toBe(true)
    expect(fakes.asc.subs.prices.get(id)).toHaveLength(5)
    expect((await replan(list, true)).actions).toEqual([])
    noDelete()
  })

  test('a differing trial is never replaced: no write, a differs row', async () => {
    const g = fakes.asc.subs.seedGroup({ referenceName: 'pro', localizations: { 'en-US': 'Pro' } })
    fakes.asc.subs.seedSub({
      group: g,
      productId: 'app.pro.yearly',
      name: 'Pro (yearly)',
      period: 'ONE_YEAR',
      localizations: LOCALES,
      price: '39.99',
      availability: 'plan',
      offers: [{ duration: 'THREE_DAYS' }],
    })
    const list = [sub([yearly({ trial: 'ONE_WEEK' })])]
    const r = await sync(list)
    expect(r.plan).toEqual([])
    expect(fakes.writes('asc')).toEqual([])
    const again = await replan(list)
    expect(again.rows[0]).toMatchObject({ sync: 'differs', fields: ['yearly: trial'] })
  })

  test('updates in place: name, level, localization, console extras kept; nothing deleted', async () => {
    const g = fakes.asc.subs.seedGroup({ referenceName: 'pro', localizations: { 'en-US': 'Old group' } })
    const id = fakes.asc.subs.seedSub({
      group: g,
      productId: 'app.pro.monthly',
      name: 'Old name',
      groupLevel: 1,
      localizations: {
        'en-US': { name: 'Old', description: 'Old.' },
        'de-DE': { name: 'Alt', description: 'Alt.' },
      },
      price: '4.99',
      availability: 'legacy',
    })
    fakes.asc.subs.seedSub({ group: g, productId: 'app.pro.weekly', price: '0.99', availability: 'plan' })
    fakes.asc.subs.seedGroup({ referenceName: 'legacy' })
    const list = [sub([monthly()])]
    const r = await sync(list)
    expect(r.failures).toEqual([])
    expect(r.plan.map((a) => a.kind)).toEqual(['group-localizations', 'update', 'localizations'])
    expect(fakes.asc.subs.subs.get(id)).toMatchObject({ name: 'Pro (monthly)', groupLevel: 2 })
    const locales = [...fakes.asc.subs.localizations.values()].map((l) => `${l.locale}:${l.name}`).sort()
    expect(locales).toContain('de-DE:Alt')
    expect(locales).toContain('en-US:Pro')
    const again = await replan(list)
    expect(again.actions).toEqual([])
    expect(again.rows.map((x) => [x.id, x.sync])).toEqual([
      ['pro', 'in-sync'],
      ['legacy', 'extra'],
    ])
    expect(again.rows[0]!.notes).toContain('plan app.pro.weekly is not in the file (kept)')
    noDelete()
  })

  test('an immutable period fails that subscription before any write', async () => {
    const g = fakes.asc.subs.seedGroup({ referenceName: 'pro', localizations: { 'en-US': 'Pro' } })
    fakes.asc.subs.seedSub({ group: g, productId: 'app.pro.monthly', period: 'ONE_YEAR', price: '4.99' })
    const r = await sync([sub([monthly()])])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('cannot change')
    expect(fakes.writes('asc')).toEqual([])
  })

  test('a price that is not an Apple price point fails the subscription before any write', async () => {
    const g = fakes.asc.subs.seedGroup({ referenceName: 'other' })
    fakes.asc.subs.seedSub({ group: g, productId: 'seed', price: '0.99' })
    const r = await sync([sub([monthly({ price: '4.98' })])])
    expect(r.plan.map((a) => a.kind)).toEqual(['error'])
    expect(r.failures[0]).toContain('4.98 is not an App Store price point in the USA')
    expect(fakes.writes('asc')).toEqual([])
  })

  test('with nothing to compare against, a bad price fails at apply and the next sync still plans a price', async () => {
    const list = [sub([monthly({ price: '4.98' })])]
    const r = await sync(list)
    expect(r.failures.join()).toContain('not an App Store price point')
    expect((await replan(list)).actions.map((a) => a.kind)).toEqual(['price'])
    noDelete()
  })

  test("creating a group that already exists fails with the store's error", async () => {
    fakes.asc.subs.seedGroup({ referenceName: 'pro' })
    const a = adapter()
    const list = [sub([monthly()])]
    const o = await a.observe(list)
    o.groups.length = 0
    const plan = a.diff(list, o).actions
    await expect(a.apply(plan[0]!)).rejects.toThrow('group exists')
  })

  test('an unknown bundle id is a store-level error', async () => {
    const a = appleSubscriptionsAdapter(
      createClient({ store: 'apple', base: fakes.env().KIT_ASC_API_URL, token: async () => 'jwt' }),
      { bundleId: 'no.such.app', allowPriceChange: false },
    )
    await expect(a.observe([sub()])).rejects.toThrow('No app with bundle id no.such.app')
  })

  test('parses hand-written App Store Connect responses (fixture)', async () => {
    const base = 'http://asc.test'
    const routes: Record<string, unknown> = {
      'v1/apps': { data: [{ type: 'apps', id: '1', attributes: { bundleId: 'app.example' } }] },
      'v1/apps/1/subscriptionGroups': {
        data: [{ type: 'subscriptionGroups', id: '10', attributes: { referenceName: 'pro' } }],
      },
      'v1/subscriptionGroups/10/subscriptions': {
        data: [
          {
            type: 'subscriptions',
            id: '20',
            attributes: {
              name: 'Pro (monthly)',
              productId: 'app.pro.monthly',
              subscriptionPeriod: 'ONE_MONTH',
            },
          },
        ],
      },
      'v1/subscriptions/20/prices': { data: [] },
      'v1/subscriptions/20/planAvailabilities': { data: [] },
      'v1/subscriptions/20/subscriptionAvailability': { data: null },
      'v1/subscriptions/20/introductoryOffers': { data: [] },
    }
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname.replace(/^\//, '')
      const body = routes[path]
      return body
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response(JSON.stringify({ errors: [{ status: '404', code: 'NOT_FOUND', detail: path }] }), {
            status: 404,
          })
    }) as typeof fetch
    try {
      const a = appleSubscriptionsAdapter(createClient({ store: 'apple', base, token: async () => 'jwt' }), {
        bundleId: 'app.example',
        allowPriceChange: false,
        today: TODAY,
      })
      const o = await a.observe([sub([monthly()])])
      expect(o.groups).toHaveLength(1)
      expect(o.groups[0]!.plans[0]).toMatchObject({
        productId: 'app.pro.monthly',
        period: 'ONE_MONTH',
        availability: false,
        prices: [],
        offers: [],
      })
      expect(a.diff([sub([monthly()])], o).actions.map((x) => x.kind)).toEqual([
        'group-localizations',
        'update',
        'localizations',
        'availability',
        'price',
      ])
    } finally {
      globalThis.fetch = real
    }
  })
})
