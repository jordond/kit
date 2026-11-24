import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { encodePng } from '../../src/lib/image/png'
import { checkProductFile, type Issue } from '../../src/lib/iap/check'
import { iapJsonSchema, productFileSchema, type ProductFile, schemaUrl } from '../../src/lib/iap/file'
import {
  appleDesired,
  appleSubscriptionsDesired,
  effectivePrices,
  pacificToday,
  playDesired,
  playSubscriptionsDesired,
  rcDesired,
  rcOfferingsDesired,
  resolveCatalog,
  samePrice,
} from '../../src/lib/iap/model'

const TODAY = '2026-11-24'
const VERSION = '0.12.0'
const SCHEMA = schemaUrl(VERSION)
let root = ''
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-iap-'))
  writeFileSync(join(root, 'opaque.png'), encodePng(2, 2, new Uint8Array(12)))
  writeFileSync(join(root, 'alpha.png'), encodePng(2, 2, new Uint8Array(16)))
  writeFileSync(join(root, 'notes.txt'), 'not an image')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const product = (over: Record<string, unknown> = {}) => ({
  id: 'membership_card',
  type: 'non_consumable',
  name: 'Membership Card',
  description: 'Unlimited shelf, 1080p, no watermark.',
  price: '4.99',
  ...over,
})

function parse(raw: Record<string, unknown>): ProductFile {
  return productFileSchema.parse({ $schema: SCHEMA, ...raw })
}

function check(raw: Record<string, unknown>): Issue[] {
  const withSchema = { $schema: SCHEMA, ...raw }
  return checkProductFile(productFileSchema.parse(withSchema), {
    root,
    today: TODAY,
    version: VERSION,
    raw: withSchema,
  })
}

const errors = (raw: Record<string, unknown>) =>
  check(raw)
    .filter((i) => i.level === 'error')
    .map((i) => `${i.path}: ${i.message}`)
const warnings = (raw: Record<string, unknown>) =>
  check(raw)
    .filter((i) => i.level === 'warn')
    .map((i) => `${i.path}: ${i.message}`)

describe('product file schema', () => {
  test('defaults locale and products; strict keys', () => {
    expect(productFileSchema.parse({})).toEqual({ locale: 'en-US', products: [] })
    expect(productFileSchema.safeParse({ products: [product({ colour: 'red' })] }).success).toBe(false)
    expect(productFileSchema.safeParse({ products: [product({ type: 'subscription' })] }).success).toBe(false)
  })

  test('price is a two-decimal string', () => {
    expect(productFileSchema.safeParse({ products: [product({ price: '4.9' })] }).success).toBe(false)
    expect(productFileSchema.safeParse({ products: [product({ price: 4.99 })] }).success).toBe(false)
  })

  test('subscriptions parse (phase 2 format is fixed now)', () => {
    const f = parse({
      subscriptions: [
        {
          id: 'pro',
          name: 'Pro',
          description: 'Everything',
          plans: [{ id: 'monthly', period: 'P1M', price: '4.99', trial: 'P1W' }],
        },
      ],
    })
    expect(f.subscriptions?.[0]?.plans[0]?.period).toBe('P1M')
    expect(
      productFileSchema.safeParse({
        subscriptions: [
          { id: 'pro', name: 'Pro', description: 'x', plans: [{ id: 'm', period: 'P4M', price: '1.00' }] },
        ],
      }).success,
    ).toBe(false)
  })

  test('the committed JSON schema is current', () => {
    const committed = readFileSync(resolve(import.meta.dir, '../../schemas/iap.schema.json'), 'utf8')
    expect(committed).toBe(iapJsonSchema())
  })
})

describe('check rules', () => {
  test('a good file has no issues', () => {
    expect(check({ products: [product()] })).toEqual([])
  })

  test('$schema missing or for another kit version warns', () => {
    const raw = { products: [product()] }
    expect(
      checkProductFile(parse(raw), { root, today: TODAY, version: VERSION, raw }).map((i) => i.path),
    ).toEqual(['$schema'])
    expect(warnings({ $schema: schemaUrl('0.11.0'), products: [product()] })[0]).toContain(
      'another kit version',
    )
  })

  test('product id shape and length', () => {
    expect(errors({ products: [product({ id: 'Membership' })] })[0]).toStartWith('products[0].id:')
    expect(errors({ products: [product({ id: '_x' })] })).toHaveLength(1)
    expect(errors({ products: [product({ id: 'a-b' })] })).toHaveLength(1)
    expect(errors({ products: [product({ id: 'a'.repeat(101) })] })[0]).toContain('limit is 100')
    expect(errors({ products: [product({ id: 'pack.10_x' })] })).toEqual([])
  })

  test('subscription id ≤ 40', () => {
    const sub = (id: string) => ({
      subscriptions: [
        { id, name: 'Pro', description: 'x', plans: [{ id: 'monthly', period: 'P1M', price: '1.00' }] },
      ],
    })
    expect(errors(sub('a'.repeat(40)))).toEqual([])
    expect(errors(sub('a'.repeat(41)))[0]).toContain('limit is 40')
  })

  test('Play purchase option and base plan ids', () => {
    expect(errors({ products: [product({ play: { purchaseOptionId: 'buy_now' } })] })[0]).toContain(
      'a-z 0-9 -',
    )
    expect(errors({ products: [product({ play: { purchaseOptionId: 'b'.repeat(64) } })] })[0]).toContain('63')
    expect(errors({ products: [product({ play: { purchaseOptionId: 'buy-now' } })] })).toEqual([])
    const sub = {
      subscriptions: [
        {
          id: 'pro',
          name: 'Pro',
          description: 'x',
          plans: [
            { id: 'Monthly', period: 'P1M', price: '1.00' },
            { id: 'yearly', period: 'P1Y', price: '9.00' },
            { id: 'yearly', period: 'P1Y', price: '9.00' },
          ],
        },
      ],
    }
    const e = errors(sub)
    expect(e.some((m) => m.startsWith('subscriptions[0].plans[0].id'))).toBe(true)
    expect(e.some((m) => m.includes('appears twice'))).toBe(true)
  })

  test('Apple product ids, derived or given', () => {
    const sub = (plan: Record<string, unknown>) => ({
      subscriptions: [
        { id: 'pro', name: 'Pro', description: 'x', plans: [{ period: 'P1M', price: '1.00', ...plan }] },
      ],
    })
    expect(errors(sub({ id: 'monthly-intro' }))).toEqual([])
    expect(errors(sub({ id: 'monthly', appleProductId: 'pro monthly' }))[0]).toContain('A-Z a-z 0-9')
    expect(errors(sub({ id: 'monthly', appleProductId: 'x'.repeat(101) }))[0]).toContain('limit is 100')
  })

  test('duplicate ids across products, subscriptions and derived Apple ids', () => {
    expect(errors({ products: [product(), product()] })[0]).toContain('already used by products[0]')
    const clash = {
      products: [product({ id: 'pro_monthly' })],
      subscriptions: [
        {
          id: 'pro',
          name: 'Pro',
          description: 'x',
          plans: [{ id: 'monthly', period: 'P1M', price: '1.00' }],
        },
      ],
    }
    expect(errors(clash)[0]).toContain('"pro_monthly" is already used')
    const subVsProduct = {
      products: [product({ id: 'pro' })],
      subscriptions: [
        {
          id: 'pro',
          name: 'Pro',
          description: 'x',
          plans: [{ id: 'monthly', period: 'P1M', price: '1.00' }],
        },
      ],
    }
    expect(errors(subVsProduct)[0]).toContain('"pro" is already used')
  })

  test('name: Apple 2–30, reference name ≤ 64', () => {
    expect(errors({ products: [product({ name: 'X' })] })[0]).toContain('at least 2')
    expect(errors({ products: [product({ name: 'n'.repeat(31) })] })[0]).toContain(
      '31 characters; the limit is 30',
    )
    expect(errors({ products: [product({ name: 'n'.repeat(30) })] })).toEqual([])
    expect(errors({ products: [product({ apple: { referenceName: 'r'.repeat(65) } })] })[0]).toContain('64')
  })

  test('description: 45 (Apple, tighter than Play 200 / 80)', () => {
    expect(errors({ products: [product({ description: 'd'.repeat(45) })] })).toEqual([])
    expect(errors({ products: [product({ description: 'd'.repeat(46) })] })[0]).toContain('limit is 45')
    // Characters, not UTF-16 units.
    expect(errors({ products: [product({ description: '🎞'.repeat(45) })] })).toEqual([])
  })

  test('reviewNote ≤ 4000', () => {
    expect(errors({ products: [product({ apple: { reviewNote: 'n'.repeat(4001) } })] })[0]).toContain('4000')
  })

  test('price > 0', () => {
    expect(errors({ products: [product({ price: '0.00' })] })[0]).toContain('more than 0')
  })

  test('priceChanges: valid dates, increasing, within next year; a past one warns', () => {
    const changes = (priceChanges: unknown[]) => ({ products: [product({ priceChanges })] })
    expect(errors(changes([{ from: '2027-02-01', price: '7.99' }]))).toEqual([])
    expect(errors(changes([{ from: '2027-02-30', price: '7.99' }]))[0]).toContain('not a date')
    expect(errors(changes([{ from: '27-02-01', price: '7.99' }]))[0]).toContain('not a date')
    expect(
      errors(
        changes([
          { from: '2027-03-01', price: '7.99' },
          { from: '2027-02-01', price: '8.99' },
        ]),
      )[0],
    ).toContain('not after 2027-03-01')
    expect(errors(changes([{ from: '2028-01-01', price: '7.99' }]))[0]).toContain('after 2027-12-31')
    expect(errors(changes([{ from: '2027-12-31', price: '7.99' }]))).toEqual([])
    expect(errors(changes([{ from: TODAY, price: '7.99' }]))).toEqual([])
    expect(warnings(changes([{ from: TODAY, price: '7.99' }]))[0]).toContain('is the current price')
  })

  test('reviewScreenshot: exists, an image, no alpha', () => {
    const shot = (reviewScreenshot: string) => ({ products: [product({ apple: { reviewScreenshot } })] })
    expect(errors(shot('opaque.png'))).toEqual([])
    expect(errors(shot('missing.png'))[0]).toContain('not found')
    expect(errors(shot('alpha.png'))[0]).toContain('alpha')
    expect(errors(shot('notes.txt'))[0]).toContain('Not a PNG or JPEG')
  })

  test('locales: BCP-47 shape; default not repeated', () => {
    expect(errors({ locale: 'english', products: [product()] })[0]).toStartWith('locale:')
    const loc = (localizations: Record<string, unknown>) => ({ products: [product({ localizations })] })
    expect(errors(loc({ 'fr-FR': { name: 'Carte', description: 'Tout.' } }))).toEqual([])
    expect(errors(loc({ 'en-US': { name: 'Card', description: 'All.' } }))[0]).toContain('default locale')
    expect(errors(loc({ fr_FR: { name: 'Carte', description: 'Tout.' } }))[0]).toContain('BCP-47')
    expect(errors(loc({ 'fr-FR': { name: 'C', description: 'Tout.' } }))[0]).toContain('at least 2')
  })

  test('benefits ≤ 4 × ≤ 40', () => {
    const sub = (benefits: string[]) => ({
      subscriptions: [
        {
          id: 'pro',
          name: 'Pro',
          description: 'x',
          benefits,
          plans: [{ id: 'm', period: 'P1M', price: '1.00' }],
        },
      ],
    })
    expect(errors(sub(['a', 'b', 'c', 'd', 'e']))[0]).toContain('at most 4')
    expect(errors(sub(['b'.repeat(41)]))[0]).toContain('limit is 40')
  })

  test('offerings: unique ids, one current, packages point at the file', () => {
    const sub = {
      id: 'pro',
      name: 'Pro',
      description: 'All of it.',
      plans: [{ id: 'monthly', period: 'P1M', price: '4.99' }],
    }
    const offering = (over: Record<string, unknown> = {}) => ({
      id: 'default',
      current: true,
      packages: [
        { id: '$rc_monthly', product: 'pro:monthly' },
        { id: 'lifetime', product: 'membership_card' },
      ],
      ...over,
    })
    expect(errors({ products: [product()], subscriptions: [sub], offerings: [offering()] })).toEqual([])
    expect(
      errors({
        products: [product()],
        subscriptions: [sub],
        offerings: [
          offering(),
          offering({
            packages: [
              { id: 'a b', product: 'pro:yearly' },
              { id: 'x', product: 'pro' },
              { id: 'x', product: 'membership_card' },
            ],
          }),
        ],
      }),
    ).toEqual([
      'offerings[1].id: offering "default" appears twice',
      'offerings[1].packages[0].id: "a b" must not be empty or hold spaces',
      'offerings[1].packages[0].product: "pro:yearly" is not a product id or "subscription:plan" in this file',
      'offerings[1].packages[1].product: "pro" is not a product id or "subscription:plan" in this file',
      'offerings[1].packages[2].id: package "x" appears twice in default',
      'offerings: only one offering can be current: default, default',
    ])
  })

  test('consumables cannot be family sharable', () => {
    expect(
      errors({ products: [product({ type: 'consumable', apple: { familySharable: true } })] })[0],
    ).toContain('non-consumables only')
  })
})

describe('model', () => {
  const iap = { products: 'p.json', apple: { familySharing: true } }

  test('defaults: entitlement, reference name, family sharing, purchase option', () => {
    const c = resolveCatalog(
      root,
      iap,
      parse({
        products: [
          product(),
          product({
            id: 'tokens',
            type: 'consumable',
            entitlement: 'credits',
            apple: { referenceName: 'Tokens ref' },
          }),
          product({ id: 'x2', apple: { familySharable: false }, play: { purchaseOptionId: 'one' } }),
        ],
      }),
    )
    const [card, tokens, x2] = c.products
    expect(card!.entitlement).toBe('membership_card')
    expect(card!.apple.referenceName).toBe('Membership Card')
    expect(card!.apple.familySharable).toBe(true)
    expect(card!.play.purchaseOptionId).toBe('buy')
    expect(tokens!.entitlement).toBe('credits')
    expect(tokens!.apple.referenceName).toBe('Tokens ref')
    expect(tokens!.apple.familySharable).toBe(false)
    expect(x2!.apple.familySharable).toBe(false)
    expect(x2!.play.purchaseOptionId).toBe('one')
    expect(Object.keys(card!.localizations)).toEqual(['en-US'])
  })

  test('effective prices: changes on or before today become current', () => {
    const p = {
      price: '4.99',
      priceChanges: [
        { from: '2027-02-01', price: '7.99' },
        { from: '2026-11-01', price: '5.99' },
      ],
    }
    expect(effectivePrices(p, TODAY)).toEqual({
      current: '5.99',
      scheduled: [{ from: '2027-02-01', price: '7.99' }],
    })
    expect(effectivePrices(p, '2027-02-01')).toEqual({ current: '7.99', scheduled: [] })
  })

  test('per-store desired shapes', () => {
    const c = resolveCatalog(
      root,
      iap,
      parse({
        products: [
          product({
            localizations: { 'fr-FR': { name: 'Carte', description: 'Tout.' } },
            apple: { reviewScreenshot: 'opaque.png', reviewNote: 'Unlocks.' },
          }),
        ],
      }),
    )
    const [apple] = appleDesired(c, TODAY)
    expect(apple).toMatchObject({
      productId: 'membership_card',
      type: 'NON_CONSUMABLE',
      familySharable: true,
      price: '4.99',
      reviewNote: 'Unlocks.',
      screenshot: { fileName: 'opaque.png' },
    })
    expect(apple!.screenshot!.md5).toMatch(/^[0-9a-f]{32}$/)
    const [play] = playDesired(c, TODAY)
    expect(play!.listings).toEqual({
      'en-US': { title: 'Membership Card', description: 'Unlimited shelf, 1080p, no watermark.' },
      'fr-FR': { title: 'Carte', description: 'Tout.' },
    })
    expect(rcDesired(c, { apple: true, play: false })[0]).toEqual({
      id: 'membership_card',
      type: 'non_consumable',
      displayName: 'Membership Card',
      entitlement: 'membership_card',
      entitlementName: 'Membership Card',
      apple: 'membership_card',
      play: undefined,
    })
  })

  test('subscriptions and offerings per store', () => {
    const c = resolveCatalog(
      root,
      iap,
      parse({
        products: [product()],
        subscriptions: [
          {
            id: 'pro',
            name: 'Pro',
            description: 'All of it.',
            benefits: ['No ads'],
            localizations: { 'fr-FR': { name: 'Pro FR', description: 'Tout.' } },
            plans: [
              { id: 'yearly', period: 'P1Y', price: '29.99', trial: 'P1W' },
              { id: 'monthly-v2', period: 'P1M', price: '3.99' },
            ],
            apple: { groupName: 'PocketVCR Pro', reviewScreenshot: 'opaque.png' },
          },
        ],
        offerings: [
          {
            id: 'default',
            current: true,
            packages: [
              { id: '$rc_annual', product: 'pro:yearly' },
              { id: 'lifetime', name: 'Forever', product: 'membership_card' },
            ],
          },
        ],
      }),
    )
    const [sub] = c.subscriptions
    expect(sub!.entitlement).toBe('pro')
    expect(sub!.apple.familySharable).toBe(true)
    expect(sub!.plans.map((p) => p.appleProductId)).toEqual(['pro_yearly', 'pro_monthly_v2'])

    const [group] = appleSubscriptionsDesired(c)
    expect(group!.groupLocalizations).toEqual({ 'en-US': 'PocketVCR Pro' })
    expect(group!.plans[0]).toMatchObject({
      ref: 'pro:yearly',
      productId: 'pro_yearly',
      name: 'Pro (yearly)',
      period: 'ONE_YEAR',
      groupLevel: 1,
      trial: 'ONE_WEEK',
      screenshot: { fileName: 'opaque.png' },
    })
    expect(group!.plans[1]).toMatchObject({ period: 'ONE_MONTH', groupLevel: 2, trial: undefined })

    const [play] = playSubscriptionsDesired(c)
    expect(play!.listings['fr-FR']).toEqual({ title: 'Pro FR', description: 'Tout.', benefits: ['No ads'] })
    expect(play!.basePlans.map((b) => [b.basePlanId, b.legacyCompatible, b.trial])).toEqual([
      ['yearly', true, 'P1W'],
      ['monthly-v2', false, undefined],
    ])

    const rc = rcDesired(c, { apple: true, play: true })
    expect(rc.map((r) => [r.id, r.type, r.apple, r.play, r.displayName])).toEqual([
      ['membership_card', 'non_consumable', 'membership_card', 'membership_card', 'Membership Card'],
      ['pro:yearly', 'subscription', 'pro_yearly', 'pro:yearly', 'Pro (yearly)'],
      ['pro:monthly-v2', 'subscription', 'pro_monthly_v2', 'pro:monthly-v2', 'Pro (monthly)'],
    ])
    expect(rc[1]!.entitlementName).toBe('Pro')

    expect(rcOfferingsDesired(c)).toEqual([
      {
        lookupKey: 'default',
        displayName: 'default',
        current: true,
        packages: [
          { lookupKey: '$rc_annual', displayName: 'Pro', position: 1, product: 'pro:yearly' },
          { lookupKey: 'lifetime', displayName: 'Forever', position: 2, product: 'membership_card' },
        ],
      },
    ])
  })

  test('helpers', () => {
    expect(samePrice('4.99', '4.990')).toBe(true)
    expect(samePrice('499.0', '499')).toBe(true)
    expect(samePrice('4.99', '5')).toBe(false)
    // 2026-11-25 07:59 UTC is still the 24th in California.
    expect(pacificToday(new Date('2026-11-25T07:59:00Z'))).toBe('2026-11-24')
  })
})

describe('config', () => {
  const base = { name: 'App' }
  test('iap.apple needs a bundle id from somewhere; iap.play a package name', () => {
    const r = configSchema.safeParse({ ...base, iap: { products: 'p.json', apple: {}, play: {} } })
    expect(r.success).toBe(false)
    expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual([
      'iap.apple.bundleId',
      'iap.play.packageName',
    ])
    const ok = configSchema.parse({
      ...base,
      iap: {
        products: 'p.json',
        apple: { bundleId: 'a.b' },
        play: { packageName: 'a.b' },
        revenuecat: { projectId: 'p' },
      },
    })
    expect(ok.iap?.apple?.familySharing).toBe(false)
    expect(ok.iap?.revenuecat?.apiKeyEnv).toBe('REVENUECAT_API_KEY')
  })
})
