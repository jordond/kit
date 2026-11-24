import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { encodePng } from '../../src/lib/image/png'
import {
  type AppleIap,
  type AppleObserved,
  appleAdapter,
  diffApple,
  observedPrices,
} from '../../src/lib/iap/apple'
import { createClient } from '../../src/lib/iap/http'
import type { AppleDesired } from '../../src/lib/iap/model'
import { type Fakes, startFakes } from '../helpers/iap-fakes'

const TODAY = '2026-11-24'

const desired = (over: Partial<AppleDesired> = {}): AppleDesired => ({
  productId: 'membership_card',
  type: 'NON_CONSUMABLE',
  referenceName: 'Membership Card',
  familySharable: true,
  localizations: { 'en-US': { name: 'Membership Card', description: 'Unlimited shelf.' } },
  price: '4.99',
  scheduled: [],
  ...over,
})

const iap = (over: Partial<AppleIap> = {}): AppleIap => ({
  ascId: '1',
  productId: 'membership_card',
  type: 'NON_CONSUMABLE',
  referenceName: 'Membership Card',
  familySharable: true,
  state: 'READY_TO_SUBMIT',
  version: { id: 'v1', state: 'PREPARE_FOR_SUBMISSION' },
  hasDraft: true,
  localizations: [{ id: 'l1', locale: 'en-US', name: 'Membership Card', description: 'Unlimited shelf.' }],
  prices: [{ startDate: null, endDate: null, customerPrice: '4.99' }],
  availability: true,
  ...over,
})

const observed = (iaps: AppleIap[]): AppleObserved => ({
  appId: 'app',
  bundleId: 'app.example',
  today: TODAY,
  iaps,
})
const kinds = (d: { actions: { kind: string }[] }) => d.actions.map((a) => a.kind)

describe('diffApple', () => {
  test('missing: create, localization, price, availability, screenshot', () => {
    const d = diffApple(
      [
        desired({
          scheduled: [{ from: '2027-02-01', price: '7.99' }],
          screenshot: { path: '/x.png', fileName: 'x.png', size: 3, md5: 'abc' },
        }),
      ],
      observed([]),
    )
    expect(kinds(d)).toEqual(['create', 'localizations', 'price', 'availability', 'screenshot'])
    expect(d.actions.map((a) => a.summary)).toEqual([
      'create',
      'localization en-US',
      'price 4.99 (7.99 from 2027-02-01)',
      'availability',
      'screenshot',
    ])
    expect(d.actions[0]!.payload).toEqual({
      attributes: {
        name: 'Membership Card',
        productId: 'membership_card',
        inAppPurchaseType: 'NON_CONSUMABLE',
        familySharable: true,
      },
    })
    expect(d.rows[0]).toMatchObject({ sync: 'missing' })
    expect(d.rows[0]!.notes).toContain(
      "the first non-consumable ships with the app's next version: submit it from App Store Connect",
    )
    expect(d.rows[0]!.notes).toContain('scheduled 7.99 from 2027-02-01')
  })

  test('consumables are created without familySharable', () => {
    const d = diffApple([desired({ type: 'CONSUMABLE', familySharable: false })], observed([]))
    expect((d.actions[0]!.payload as { attributes: object }).attributes).not.toHaveProperty('familySharable')
  })

  test('in sync: nothing to do; first-of-type note gone once one is approved', () => {
    const d = diffApple(
      [desired()],
      observed([iap(), iap({ productId: 'other', state: 'APPROVED', ascId: '2' })]),
      {
        extras: false,
      },
    )
    expect(d.actions).toEqual([])
    expect(d.rows).toEqual([
      {
        store: 'apple',
        id: 'membership_card',
        sync: 'in-sync',
        storeState: 'READY_TO_SUBMIT · version PREPARE_FOR_SUBMISSION',
        notes: ['no review screenshot: App Store Connect keeps it MISSING_METADATA'],
      },
    ])
  })

  test('extra products are listed, never acted on', () => {
    const d = diffApple([desired()], observed([iap(), iap({ productId: 'old_test', ascId: '9' })]))
    expect(d.rows.find((r) => r.id === 'old_test')).toMatchObject({ sync: 'extra' })
    expect(d.actions).toEqual([])
    expect(
      diffApple([desired()], observed([iap(), iap({ productId: 'old_test' })]), { extras: false }).rows,
    ).toHaveLength(1)
  })

  test('differs: each field', () => {
    const cases: [Partial<AppleIap>, Partial<AppleDesired>, string[], string[]][] = [
      [{ referenceName: 'Old' }, {}, ['referenceName'], ['update']],
      [{ reviewNote: 'old' }, { reviewNote: 'new' }, ['reviewNote'], ['update']],
      [{ familySharable: false }, {}, ['familySharable'], ['update']],
      [
        { localizations: [{ id: 'l', locale: 'en-US', name: 'Old', description: 'Unlimited shelf.' }] },
        {},
        ['localization en-US'],
        ['localizations'],
      ],
      [
        {},
        { localizations: { ...desired().localizations, 'fr-FR': { name: 'Carte', description: 'Tout.' } } },
        ['localization fr-FR'],
        ['localizations'],
      ],
      [{ prices: [{ startDate: null, endDate: null, customerPrice: '3.99' }] }, {}, ['price'], ['price']],
      [{}, { scheduled: [{ from: '2027-02-01', price: '7.99' }] }, ['price'], ['price']],
      [{ prices: [] }, {}, ['price'], ['price']],
      [{ availability: false }, {}, ['availability'], ['availability']],
      [
        {},
        { screenshot: { path: '/s.png', fileName: 's.png', size: 3, md5: 'abc' } },
        ['screenshot'],
        ['screenshot'],
      ],
    ]
    for (const [o, d, fields, acts] of cases) {
      const r = diffApple([desired(d)], observed([iap(o)]))
      expect({ fields: r.rows[0]!.fields, acts: kinds(r) }).toEqual({ fields, acts })
    }
  })

  test('a file without reviewNote leaves the store note alone', () => {
    expect(diffApple([desired()], observed([iap({ reviewNote: 'console note' })])).actions).toEqual([])
  })

  test('localization edits on a non-draft version say a new version is made', () => {
    const r = diffApple(
      [desired({ localizations: { 'en-US': { name: 'New', description: 'Unlimited shelf.' } } })],
      observed([iap({ hasDraft: false, version: { id: 'v', state: 'APPROVED' } })]),
    )
    expect(r.actions[0]!.summary).toBe('localization en-US (new version)')
  })

  test('extra console locales are kept and noted', () => {
    const r = diffApple(
      [desired()],
      observed([
        iap({
          localizations: [
            ...iap().localizations,
            { id: 'l2', locale: 'de-DE', name: 'Karte', description: 'x' },
          ],
        }),
      ]),
    )
    expect(r.actions).toEqual([])
    expect(r.rows[0]!.notes).toContain('localization de-DE is not in the file (kept)')
  })

  test('immutable type and Family Sharing true→false are error actions', () => {
    const t = diffApple([desired({ type: 'CONSUMABLE', familySharable: false })], observed([iap()]))
    expect(t.actions[0]).toMatchObject({ kind: 'error' })
    expect(t.actions[0]!.summary).toContain('cannot change')
    const f = diffApple([desired({ familySharable: false })], observed([iap()]))
    expect(f.rows[0]!.fields).toEqual(['familySharable'])
    expect(f.actions.map((a) => a.summary)).toEqual([
      'error: Family Sharing is on and Apple cannot turn it off; set familySharable: true',
    ])
  })

  test('a differing screenshot is reported, never deleted or replaced', () => {
    const shot = { path: '/s.png', fileName: 's.png', size: 3, md5: 'abc' }
    const same = diffApple(
      [desired({ screenshot: shot })],
      observed([iap({ screenshot: { id: 's', checksum: 'ABC' } })]),
    )
    expect(same.rows[0]!.sync).toBe('in-sync')
    const other = diffApple(
      [desired({ screenshot: shot })],
      observed([iap({ screenshot: { id: 's', checksum: 'def' } })]),
    )
    expect(other.rows[0]).toMatchObject({ sync: 'differs', fields: ['screenshot'] })
    expect(other.rows[0]!.notes!.join()).toContain('kit never deletes')
    expect(other.actions).toEqual([])
  })

  test('a screenshot that never finished uploading is not in sync', () => {
    const r = diffApple(
      [desired({ screenshot: { path: '/s.png', fileName: 's.png', size: 3, md5: 'abc' } })],
      observed([
        iap({
          screenshot: {
            id: 's1',
            fileName: 's.png',
            fileSize: 3,
            state: 'AWAITING_UPLOAD',
          },
        }),
      ]),
    )
    expect(r.rows[0]).toMatchObject({ sync: 'differs', fields: ['screenshot'] })
    expect(r.rows[0]!.notes!.join()).toContain('its upload never finished')
    expect(r.actions).toEqual([])
  })

  test('observed prices: past changes are current, expired ones dropped, future ones scheduled', () => {
    expect(
      observedPrices(
        [
          { startDate: null, endDate: '2026-11-01', customerPrice: '3.99' },
          { startDate: '2026-11-01', endDate: null, customerPrice: '4.99' },
          { startDate: '2027-02-01', endDate: null, customerPrice: '7.99' },
        ],
        TODAY,
      ),
    ).toEqual({ current: '4.99', inEffect: ['4.99'], scheduled: [{ from: '2027-02-01', price: '7.99' }] })
    // A kept-for-subscribers price next to the new one: the unpreserved one is current, both in effect.
    for (const order of [
      [false, true],
      [true, false],
    ]) {
      const tied = observedPrices(
        [
          { startDate: null, endDate: null, customerPrice: order[0] ? '3.99' : '4.99', preserved: order[0] },
          { startDate: null, endDate: null, customerPrice: order[1] ? '3.99' : '4.99', preserved: order[1] },
        ],
        TODAY,
      )
      expect(tied.current).toBe('4.99')
      expect(tied.inEffect.sort()).toEqual(['3.99', '4.99'])
    }
    // A store that moved to the scheduled price matches a file whose change date has passed.
    const r = diffApple(
      [desired({ price: '7.99' })],
      observed([
        iap({
          prices: [
            { startDate: null, endDate: '2026-11-20', customerPrice: '4.99' },
            { startDate: '2026-11-20', endDate: null, customerPrice: '7.990' },
          ],
        }),
      ]),
    )
    expect(r.actions).toEqual([])
  })
})

describe('apple adapter against the fake', () => {
  let fakes: Fakes
  let dir = ''
  let shot: NonNullable<AppleDesired['screenshot']>
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-iap-apple-'))
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

  const adapter = () =>
    appleAdapter(
      createClient({ store: 'apple', base: fakes.env().KIT_ASC_API_URL, token: async () => 'jwt' }),
      {
        bundleId: 'app.example',
        today: TODAY,
        sleep: async () => {},
        pollMs: 1,
      },
    )

  async function sync(list: AppleDesired[]) {
    const a = adapter()
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

  for (const autoDraft of [false, true]) {
    test(`creates everything, then plans nothing (draft version auto-created: ${autoDraft})`, async () => {
      fakes.asc.autoDraftVersion = autoDraft
      const list = [
        desired({
          screenshot: shot,
          reviewNote: 'Unlocks the shelf.',
          scheduled: [{ from: '2027-02-01', price: '7.99' }],
          localizations: {
            'en-US': { name: 'Membership Card', description: 'Unlimited shelf.' },
            'fr-FR': { name: 'Carte', description: 'Tout.' },
          },
        }),
        desired({
          productId: 'tokens_10',
          type: 'CONSUMABLE',
          familySharable: false,
          referenceName: 'Tokens',
          price: '0.99',
        }),
      ]
      const first = await sync(list)
      expect(first.failures).toEqual([])
      const card = fakes.asc.byProductId('membership_card')!
      expect(card).toMatchObject({
        name: 'Membership Card',
        reviewNote: 'Unlocks the shelf.',
        familySharable: true,
      })
      expect(card.versions).toHaveLength(1)
      expect([...fakes.asc.localizations.values()].map((l) => l.locale).sort()).toEqual([
        'en-US',
        'en-US',
        'fr-FR',
      ])
      expect(fakes.asc.manualPrices.get(card.id)).toEqual([
        { startDate: null, endDate: null, price: '4.99' },
        { startDate: '2027-02-01', endDate: null, price: '7.99' },
      ])
      expect(fakes.asc.availabilities.get(card.id)).toEqual({
        territories: ['USA', 'CAN', 'GBR', 'DEU', 'JPN'],
        availableInNewTerritories: true,
      })
      const s = fakes.asc.screenshots.get(card.screenshot!)!
      expect(s).toMatchObject({ checksum: shot.md5, state: 'COMPLETE', bytes: shot.size })
      const upload = fakes.log.find((r) => r.path.startsWith('/upload/'))
      expect(upload?.auth).toBe('')

      const a = adapter()
      const o = await a.observe(list)
      const again = a.diff(list, o)
      expect(again.actions).toEqual([])
      expect(again.rows.map((r) => r.sync)).toEqual(['in-sync', 'in-sync'])
      expect(again.rows[0]!.storeState).toBe('READY_TO_SUBMIT · version PREPARE_FOR_SUBMISSION')
      expect(fakes.writes('asc').some((r) => r.method === 'DELETE')).toBe(false)
    })
  }

  test('request bodies: create, price schedule (temp ids), localization on the version', async () => {
    await sync([desired()])
    const post = (path: string) =>
      fakes.log.find((r) => r.method === 'POST' && r.path === path)!.body as Record<string, unknown>
    expect(post('v2/inAppPurchases')).toEqual({
      data: {
        type: 'inAppPurchases',
        attributes: {
          name: 'Membership Card',
          productId: 'membership_card',
          inAppPurchaseType: 'NON_CONSUMABLE',
          familySharable: true,
        },
        relationships: { app: { data: { type: 'apps', id: fakes.asc.appId } } },
      },
    })
    const id = fakes.asc.byProductId('membership_card')!.id
    expect(post('v1/inAppPurchasePriceSchedules')).toEqual({
      data: {
        type: 'inAppPurchasePriceSchedules',
        relationships: {
          inAppPurchase: { data: { type: 'inAppPurchases', id } },
          baseTerritory: { data: { type: 'territories', id: 'USA' } },
          manualPrices: { data: [{ type: 'inAppPurchasePrices', id: '${price-0}' }] },
        },
      },
      included: [
        {
          type: 'inAppPurchasePrices',
          id: '${price-0}',
          attributes: { startDate: null },
          relationships: {
            inAppPurchaseV2: { data: { type: 'inAppPurchases', id } },
            inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: `pp-${id}-4.99` } },
          },
        },
      ],
    })
    const loc = post('v2/inAppPurchaseLocalizations') as {
      data: { relationships: { version: { data: { type: string } } } }
    }
    expect(loc.data.relationships.version.data.type).toBe('inAppPurchaseVersions')
  })

  test('updates an existing product in place and keeps console extras', async () => {
    fakes.asc.seed({
      productId: 'membership_card',
      name: 'Old name',
      familySharable: false,
      localizations: {
        'en-US': { name: 'Old', description: 'Unlimited shelf.' },
        'de-DE': { name: 'Karte', description: 'x' },
      },
      versionState: 'APPROVED',
      prices: [{ startDate: null, price: '3.99' }],
      availability: true,
    })
    fakes.asc.seed({ productId: 'old_test', prices: [{ startDate: null, price: '0.99' }] })
    const list = [desired()]
    const a = adapter()
    const o = await a.observe(list)
    const d = a.diff(list, o)
    expect(d.rows.find((r) => r.id === 'old_test')?.sync).toBe('extra')
    expect(d.actions.map((x) => x.summary)).toEqual([
      'update referenceName, familySharable',
      'localization en-US (new version)',
      'price 4.99',
    ])
    const r = await sync(list)
    expect(r.failures).toEqual([])
    const card = fakes.asc.byProductId('membership_card')!
    expect(card.versions).toHaveLength(2)
    const draftLocs = [...fakes.asc.localizations.values()].filter((l) => l.version === card.versions[1])
    expect(draftLocs.map((l) => `${l.locale}:${l.name}`).sort()).toEqual([
      'de-DE:Karte',
      'en-US:Membership Card',
    ])
    expect(fakes.asc.manualPrices.get(card.id)).toEqual([{ startDate: null, endDate: null, price: '4.99' }])
    expect(fakes.writes('asc').map((w) => `${w.method} ${w.path}`)).not.toContain(
      `POST v1/inAppPurchaseAvailabilities`,
    )
  })

  test('a price that is not an Apple price point fails that product before any write', async () => {
    const r = await sync([desired({ price: '4.95' }), desired({ productId: 'other', price: '1.99' })])
    expect(r.plan.filter((a) => a.id === 'membership_card').map((a) => a.kind)).toEqual(['error'])
    expect(r.failures).toEqual(['membership_card: 4.95 is not an App Store price point in the USA'])
    expect(fakes.asc.byProductId('membership_card')).toBeUndefined()
    expect(fakes.asc.byProductId('other')).toBeDefined()
  })

  test('an unknown bundle id is a store-level error', async () => {
    fakes.asc.bundleId = 'something.else'
    await expect(adapter().observe([desired()])).rejects.toThrow('No app with bundle id app.example')
  })

  test('parses a hand-written App Store Connect list response (fixture)', async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../fixtures/iap/apple/in-app-purchases-v2.json'), 'utf8'),
    ) as unknown
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname
        if (p === '/v1/apps')
          return Response.json({
            data: [{ type: 'apps', id: '6446148572', attributes: { bundleId: 'app.example' } }],
          })
        if (p.endsWith('/inAppPurchasesV2')) return Response.json(fixture)
        if (p.endsWith('/localizations')) {
          return Response.json({
            data: [
              {
                type: 'inAppPurchaseLocalizations',
                id: 'loc1',
                attributes: { locale: 'en-US', name: 'Membership Card', description: 'Unlimited shelf.' },
              },
            ],
            links: {},
          })
        }
        if (p.endsWith('/manualPrices')) {
          return Response.json({
            data: [
              {
                type: 'inAppPurchasePrices',
                id: 'mp1',
                attributes: { startDate: null, endDate: null },
                relationships: {
                  inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: 'pp1' } },
                },
              },
            ],
            included: [
              {
                type: 'inAppPurchasePricePoints',
                id: 'pp1',
                attributes: { customerPrice: '4.99', proceeds: '4.24' },
              },
            ],
            links: {},
          })
        }
        return new Response('{}', { status: 404 })
      },
    })
    try {
      const a = appleAdapter(
        createClient({ store: 'apple', base: `http://localhost:${server.port}`, token: async () => 'jwt' }),
        {
          bundleId: 'app.example',
          today: TODAY,
        },
      )
      const o = await a.observe([desired()])
      expect(o.iaps[0]).toMatchObject({
        ascId: '6446452615',
        productId: 'membership_card',
        state: 'MISSING_METADATA',
        version: { id: '7000000001', state: 'PREPARE_FOR_SUBMISSION' },
        hasDraft: true,
        availability: false,
        screenshot: undefined,
        prices: [{ startDate: null, endDate: null, customerPrice: '4.99' }],
      })
      expect(a.diff([desired()], o).actions.map((x) => x.kind)).toEqual(['availability'])
    } finally {
      await server.stop(true)
    }
  })
})
