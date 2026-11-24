import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { encodePng } from '../../src/lib/image/png'
import { schemaUrl } from '../../src/lib/iap/file'
import { pacificToday } from '../../src/lib/iap/model'
import { type Fixture, fixture } from '../helpers/fixture'
import { type Fakes, startFakes } from '../helpers/iap-fakes'

// kit iap against stateful fakes of all three stores (plan-4 §8): no network, no real accounts.

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (s: string) => Buffer.from(s).toString('base64')
const CREDS = {
  ASC_KEY_ID: 'ABC123DEFG',
  ASC_ISSUER_ID: '69a6de70-03db-47e3-e053-5b8c7c11a4d1',
  ASC_KEY_P8_BASE64: b64(ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
  PLAY_SERVICE_ACCOUNT_BASE64: b64(
    JSON.stringify({
      type: 'service_account',
      client_email: 'kit@shop.iam.gserviceaccount.com',
      private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  ),
  REVENUECAT_API_KEY: 'sk_fake_key',
  KIT_RC_PACE_MS: '0',
  KIT_IAP_RECORD: '',
}

/** A date about two months ahead, so the scheduled change stays in the future whenever this runs. */
const ahead = (() => {
  const d = new Date(`${pacificToday()}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 60)
  return d.toISOString().slice(0, 10)
})()

const PRODUCTS = {
  $schema: schemaUrl(pkg.version),
  locale: 'en-US',
  products: [
    {
      id: 'membership_card',
      type: 'non_consumable',
      name: 'Membership Card',
      description: 'Unlimited shelf, 1080p, no watermark.',
      price: '4.99',
      priceChanges: [{ from: ahead, price: '7.99' }],
      entitlement: 'membership',
      apple: { reviewNote: 'Unlocks the shelf.', reviewScreenshot: 'contract/review/membership_card.png' },
    },
    {
      id: 'tokens_10',
      type: 'consumable',
      name: 'Ten Tokens',
      description: 'Ten rewind tokens.',
      price: '0.99',
    },
    {
      id: 'poster_pack',
      type: 'non_consumable',
      name: 'Poster Pack',
      description: 'Twelve classic posters.',
      price: '1.99',
      localizations: { 'fr-FR': { name: 'Affiches', description: 'Douze affiches classiques.' } },
    },
  ],
}

let fakes: Fakes
let fx: Fixture
beforeEach(() => {
  fakes = startFakes()
  fx = fixture('iap-app', [])
  mkdirSync(join(fx.dir, 'contract/review'), { recursive: true })
  writeFileSync(join(fx.dir, 'contract/products.json'), JSON.stringify(PRODUCTS, null, 2))
  writeFileSync(
    join(fx.dir, 'contract/review/membership_card.png'),
    encodePng(8, 8, new Uint8Array(8 * 8 * 3)),
  )
})
afterEach(() => {
  fakes.stop()
  fx.cleanup()
})

const iap = (args: string[], env: Record<string, string> = {}) =>
  fx.kit(['iap', ...args], { env: { ...fakes.env(), ...CREDS, ...env } })

interface Doc {
  ok: boolean
  stores: Record<
    string,
    {
      label: string
      skipped?: string
      error?: string
      rows: { id: string; sync: string; fields?: string[] }[]
      actions: { id: string; kind: string; summary: string }[]
      results?: { id: string; kind: string; ok: boolean; skipped?: boolean; error?: string }[]
    }
  >
}
const doc = (stdout: string) => JSON.parse(stdout) as Doc

describe('kit iap', () => {
  test('check passes the file', async () => {
    const r = await iap(['check'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('contract/products.json: 3 products')
  })

  test('sync --dry-run plans 3 creates per store and writes nothing', async () => {
    const r = await iap(['sync', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('App Store Connect (app.example)')
    expect(r.stderr).toMatch(/App Store Connect \(app\.example\)\s+3 create, 0 update, 0 in sync/)
    expect(r.stderr).toMatch(/Google Play \(app\.example\)\s+3 create/)
    expect(r.stderr).toMatch(
      /RevenueCat \(projd2d1fc4a\)\s+3 create, 0 update, 0 in sync, 6 products, 3 entitlements, 3 attaches/,
    )
    expect(r.stderr).toContain(
      `+ membership_card  create · localization en-US · price 4.99 (7.99 from ${ahead}) · availability · screenshot`,
    )
    expect(r.stderr).toContain('Dry run: nothing applied')
    expect(fakes.writes()).toEqual([])
  })

  test('the --json plan document', async () => {
    const r = await iap(['sync', '--dry-run', '--json'])
    expect(r.code).toBe(0)
    const d = doc(r.stdout)
    expect(Object.keys(d.stores)).toEqual(['apple', 'play', 'revenuecat'])
    // Dates move with the clock; the shape must not.
    expect(JSON.parse(r.stdout.replaceAll(ahead, '<ahead>'))).toMatchSnapshot()
    expect(fakes.writes()).toEqual([])
  })

  test('sync --yes, then status is all in sync and a second sync plans nothing', async () => {
    const first = await iap(['sync', '--yes', '--json'])
    expect(first.stderr).not.toContain('✖')
    expect(first.code).toBe(0)
    const applied = doc(first.stdout)
    expect(applied.ok).toBe(true)
    for (const s of ['apple', 'play', 'revenuecat']) {
      expect(applied.stores[s]!.results!.every((x) => x.ok)).toBe(true)
    }
    expect(fakes.asc.byProductId('membership_card')).toMatchObject({
      familySharable: true,
      reviewNote: 'Unlocks the shelf.',
    })
    expect(fakes.asc.byProductId('tokens_10')).toMatchObject({
      inAppPurchaseType: 'CONSUMABLE',
      familySharable: false,
    })
    expect([...fakes.play.products.keys()].sort()).toEqual(['membership_card', 'poster_pack', 'tokens_10'])
    expect(fakes.rc.products.size).toBe(6)

    const status = await iap(['status', '--json'])
    expect(status.code).toBe(0)
    const s = doc(status.stdout)
    for (const store of Object.values(s.stores)) {
      expect(store.rows.map((x) => `${x.id} ${x.sync}`)).toEqual([
        'membership_card in-sync',
        'tokens_10 in-sync',
        'poster_pack in-sync',
      ])
    }
    const human = await iap(['status'])
    expect(human.stderr).toContain('READY_TO_SUBMIT')
    expect(human.stderr).toContain("the first non-consumable ships with the app's next version")

    const before = fakes.writes().length
    const second = await iap(['sync', '--yes'])
    expect(second.code).toBe(0)
    expect(second.stderr).toContain('Nothing to do: every store matches the file')
    expect(fakes.writes().length).toBe(before)
    expect(
      fakes
        .writes()
        .some((w) => w.method === 'DELETE' || /detach|archive|deactivate|Submission/.test(w.path)),
    ).toBe(false)
  })

  test('a store without credentials is skipped with a warning; the others apply', async () => {
    const r = await iap(['sync', '--yes'], { PLAY_SERVICE_ACCOUNT_BASE64: '' })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Google Play (app.example): skipped, missing PLAY_SERVICE_ACCOUNT_BASE64')
    expect(fakes.play.products.size).toBe(0)
    expect(fakes.writes('play')).toEqual([])
    expect(fakes.asc.iaps.size).toBe(3)
    expect(fakes.rc.products.size).toBe(6)
  })

  test('a store that cannot be read fails alone; the others apply, exit 1', async () => {
    fakes.asc.bundleId = 'another.app'
    const r = await iap(['sync', '--yes'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('failed: No app with bundle id app.example in App Store Connect')
    expect(fakes.writes('asc')).toEqual([])
    expect(fakes.play.products.size).toBe(3)
  })

  test('one product failing on Play: the rest apply, the summary names it, exit 1', async () => {
    fakes.play.failPatch.add('tokens_10')
    const r = await iap(['sync', '--yes', '--json'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Google Play (app.example): 4 applied, 1 failed')
    expect(r.stderr).toContain('tokens_10 (upsert): Google Play: HTTP 500 INTERNAL')
    const d = doc(r.stdout)
    expect(d.ok).toBe(false)
    expect(d.stores.play!.results).toContainEqual({
      id: 'tokens_10',
      kind: 'activate',
      ok: false,
      skipped: true,
    })
    expect([...fakes.play.products.keys()].sort()).toEqual(['membership_card', 'poster_pack'])
    expect(fakes.asc.iaps.size).toBe(3)
  })

  test('--store and --product narrow the run', async () => {
    const r = await iap(['sync', '--yes', '--store', 'play', '--product', 'poster_pack'])
    expect(r.code).toBe(0)
    expect([...fakes.play.products.keys()]).toEqual(['poster_pack'])
    expect(fakes.writes('asc')).toEqual([])
    expect(fakes.writes('rc')).toEqual([])
    const bad = await iap(['status', '--product', 'nope'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('Not in the product file: nope')
  })

  test('without a terminal, sync needs --yes', async () => {
    const r = await iap(['sync'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Re-run with --yes')
    expect(fakes.writes()).toEqual([])
  })

  const WITH_SUBS = () => ({
    ...PRODUCTS,
    subscriptions: [
      {
        id: 'pro',
        name: 'Pro',
        description: 'All of it.',
        benefits: ['No ads'],
        plans: [
          { id: 'yearly', period: 'P1Y', price: '29.99', trial: 'P1W' },
          { id: 'monthly', period: 'P1M', price: '3.99' },
        ],
        apple: { groupName: 'Shop Pro' },
      },
    ],
    offerings: [
      {
        id: 'default',
        current: true,
        packages: [
          { id: '$rc_annual', product: 'pro:yearly' },
          { id: '$rc_monthly', product: 'pro:monthly' },
          { id: 'lifetime', product: 'membership_card' },
        ],
      },
    ],
  })
  const writeFile = (body: unknown) =>
    writeFileSync(join(fx.dir, 'contract/products.json'), JSON.stringify(body, null, 2))

  test('subscriptions and offerings: sync, all in sync, second sync plans nothing', async () => {
    writeFile(WITH_SUBS())
    expect((await iap(['check'])).stderr).toContain('3 products, 1 subscription, 1 offering')

    const dry = await iap(['sync', '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.stderr).toMatch(/App Store Connect \(app\.example\)\s+4 create/)
    expect(dry.stderr).toMatch(
      /RevenueCat \(projd2d1fc4a\)\s+6 create, .*10 products.*1 offerings, 3 packages/,
    )
    expect(fakes.writes()).toEqual([])

    const first = await iap(['sync', '--yes', '--json'])
    expect(first.stderr).not.toContain('✖')
    expect(first.code).toBe(0)
    expect(fakes.asc.subs.byProductId('pro_yearly')).toMatchObject({ subscriptionPeriod: 'ONE_YEAR' })
    expect(fakes.asc.subs.byProductId('pro_monthly')).toMatchObject({ groupLevel: 2 })
    expect(fakes.play.subscriptions.has('pro')).toBe(true)
    expect([...fakes.rc.products.values()].map((p) => p.store_identifier)).toContain('pro:yearly')
    expect(fakes.rc.offerings.size).toBe(1)
    expect(fakes.rc.packages.size).toBe(3)

    const status = doc((await iap(['status', '--json'])).stdout)
    for (const store of Object.values(status.stores)) {
      expect(store.rows.filter((r) => r.sync !== 'in-sync')).toEqual([])
    }

    const before = fakes.writes().length
    const second = await iap(['sync', '--yes'])
    expect(second.stderr).toContain('Nothing to do: every store matches the file')
    expect(fakes.writes().length).toBe(before)
    expect(
      fakes
        .writes()
        .some(
          (w) => w.method === 'DELETE' || /detach|archive|deactivate|migratePrices|Submission/.test(w.path),
        ),
    ).toBe(false)
  })

  test('a subscription price change needs --allow-price-change', async () => {
    writeFile(WITH_SUBS())
    expect((await iap(['sync', '--yes'])).code).toBe(0)
    const changed = WITH_SUBS()
    changed.subscriptions[0]!.plans[1]!.price = '4.99'
    writeFile(changed)

    const status = await iap(['status'])
    expect(status.stderr).toContain('monthly: price')
    expect(status.stderr).toContain('--allow-price-change')
    const before = fakes.writes().length
    const plain = await iap(['sync', '--yes'])
    expect(plain.code).toBe(0)
    expect(fakes.writes().length).toBe(before)

    const allowed = await iap(['sync', '--yes', '--allow-price-change', '--json'])
    expect(allowed.code).toBe(0)
    const d = doc(allowed.stdout)
    expect(d.stores.apple!.results!.some((r) => r.kind === 'price' && r.ok)).toBe(true)
    expect(d.stores.play!.results!.every((r) => r.ok)).toBe(true)
    expect(fakes.writes().some((w) => /migratePrices/.test(w.path))).toBe(false)

    const again = await iap(['sync', '--dry-run', '--allow-price-change'])
    expect(again.stderr).toContain('Nothing to do: every store matches the file')
  })

  test('a file with errors stops status and sync before any request', async () => {
    writeFileSync(
      join(fx.dir, 'contract/products.json'),
      JSON.stringify({ ...PRODUCTS, products: [{ ...PRODUCTS.products[1], name: 'X' }] }),
    )
    const r = await iap(['sync', '--dry-run'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('products[0].name: name must be at least 2 characters')
    expect(fakes.log).toEqual([])
  })
})
