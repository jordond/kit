import { type Json, json, type Req } from './common'

// Stateful Google Play (Android Publisher) fake.

interface Money {
  currencyCode: string
  units: string
  nanos?: number
}

export const money = (price: string, currencyCode = 'USD'): Money => {
  const [u, f = '0'] = price.split('.')
  return { currencyCode, units: u!, nanos: Number(f.padEnd(9, '0').slice(0, 9)) }
}

const moneyNumber = (m: Money) => Number(m.units) + (m.nanos ?? 0) / 1e9

export class FakePlay {
  packageName = 'app.example'
  regionVersion = '2026/01'
  pageSize = 2
  products = new Map<string, Json>()
  /** Product ids whose PATCH answers 500 (a known Play issue). */
  failPatch = new Set<string>()
  /** Every convert call scales other regions by this (FX moves between runs). */
  fx = 1
  convertCalls = 0
  subscriptions = new Map<string, Json>()
  /** Offers by `subscription/basePlan/offerId`. */
  offers = new Map<string, Json>()
  /** Subscription ids whose PATCH answers 500. */
  failSubPatch = new Set<string>()
  /** A new subscription may not carry base plans: they must be PATCHed in after the first call. */
  refuseBasePlansOnCreate = false
  /** Writes to subscriptions answer 403 like an account without a payments profile. */
  noBilling = false

  private error(status: number, code: string, message: string) {
    return json({ error: { code: status, status: code, message } }, status)
  }

  /** A product as if made in the console. */
  seed(
    productId: string,
    opts: { title: string; description: string; price: string; state?: string; legacy?: boolean },
  ) {
    this.products.set(productId, {
      packageName: this.packageName,
      productId,
      listings: [{ languageCode: 'en-US', title: opts.title, description: opts.description }],
      purchaseOptions: [
        {
          purchaseOptionId: 'buy',
          state: opts.state ?? 'ACTIVE',
          buyOption: { legacyCompatible: opts.legacy ?? true, multiQuantityEnabled: false },
          regionalPricingAndAvailabilityConfigs: this.convert(opts.price).configs,
          newRegionsConfig: {
            usdPrice: money(opts.price),
            eurPrice: money(opts.price, 'EUR'),
            availability: 'AVAILABLE',
          },
        },
      ],
      regionsVersion: { version: this.regionVersion },
    })
  }

  /** A subscription as if made in the console. */
  seedSubscription(
    productId: string,
    opts: {
      title: string
      description: string
      benefits?: string[]
      plans: { id: string; period: string; price: string; state?: string; legacy?: boolean }[]
    },
  ) {
    this.subscriptions.set(productId, {
      packageName: this.packageName,
      productId,
      listings: [
        {
          languageCode: 'en-US',
          title: opts.title,
          description: opts.description,
          benefits: opts.benefits ?? [],
        },
      ],
      basePlans: opts.plans.map((pl) => ({
        basePlanId: pl.id,
        state: pl.state ?? 'ACTIVE',
        autoRenewingBasePlanType: {
          billingPeriodDuration: pl.period,
          legacyCompatible: pl.legacy ?? false,
          resubscribeState: 'RESUBSCRIBE_STATE_ACTIVE',
        },
        regionalConfigs: this.convert(pl.price).configs.map((c) => ({
          regionCode: c.regionCode,
          price: c.price,
          newSubscriberAvailability: true,
        })),
        otherRegionsConfig: {
          usdPrice: money(pl.price),
          eurPrice: money(pl.price, 'EUR'),
          newSubscriberAvailability: true,
        },
      })),
    })
  }

  /** A free-trial offer as if made in the console. */
  seedOffer(
    sub: string,
    plan: string,
    opts: { offerId?: string; duration: string; state?: string; free?: boolean },
  ) {
    const offerId = opts.offerId ?? 'free-trial'
    const regions = ['US', 'DE', 'JP']
    this.offers.set(`${sub}/${plan}/${offerId}`, {
      packageName: this.packageName,
      productId: sub,
      basePlanId: plan,
      offerId,
      state: opts.state ?? 'ACTIVE',
      phases: [
        {
          duration: opts.duration,
          recurrenceCount: 1,
          regionalConfigs: regions.map((r) => ({
            regionCode: r,
            ...(opts.free === false ? { price: money('1.00') } : { free: {} }),
          })),
        },
      ],
      regionalConfigs: regions.map((r) => ({ regionCode: r, newSubscriberAvailability: true })),
    })
  }

  private subscriptionRoute(req: Req, rest: string): Response | undefined {
    let m: RegExpMatchArray | null
    const route = (method: string, re: RegExp) => (req.method === method ? (m = rest.match(re)) : null)
    if (route('GET', /^subscriptions$/)) {
      const all = [...this.subscriptions.values()]
      const start = Number(req.query.get('pageToken') ?? 0)
      const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined
      return json({
        subscriptions: all.slice(start, start + this.pageSize),
        ...(next ? { nextPageToken: next } : {}),
      })
    }
    if (route('GET', /^subscriptions\/([^/]+)\/basePlans\/([^/]+)\/offers$/)) {
      const prefix = `${m![1]}/${m![2]}/`
      const all = [...this.offers].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
      return json(all.length ? { subscriptionOffers: all } : {})
    }
    if (route('PATCH', /^subscriptions\/([^/]+)$/)) {
      const id = m![1]!
      if (this.noBilling)
        return this.error(403, 'PERMISSION_DENIED', 'Please set up a payments profile (merchant account)')
      if (this.failSubPatch.has(id)) return this.error(500, 'INTERNAL', 'Internal error encountered.')
      if (!req.query.get('updateMask')) return this.error(400, 'INVALID_ARGUMENT', 'updateMask is required')
      if (req.query.get('regionsVersion.version') !== this.regionVersion)
        return this.error(400, 'INVALID_ARGUMENT', 'Invalid regions version')
      const old = this.subscriptions.get(id)
      if (!old && req.query.get('allowMissing') !== 'true')
        return this.error(404, 'NOT_FOUND', 'no subscription')
      const body = req.body as Json
      if (body.productId !== id || body.packageName !== this.packageName)
        return this.error(400, 'INVALID_ARGUMENT', 'productId/packageName must match the path')
      const mask = String(req.query.get('updateMask')).split(',')
      const plans = (mask.includes('basePlans') ? ((body.basePlans as Json[]) ?? []) : undefined) ?? []
      if (!old && this.refuseBasePlansOnCreate && plans.length)
        return this.error(400, 'INVALID_ARGUMENT', 'base plans cannot be created with the subscription')
      for (const pl of plans)
        if ('state' in pl) return this.error(400, 'INVALID_ARGUMENT', 'state is output only')
      const typeOf = (pl: Json) => pl.autoRenewingBasePlanType as Json | undefined
      if (plans.filter((pl) => typeOf(pl)?.legacyCompatible).length > 1)
        return this.error(400, 'INVALID_ARGUMENT', 'Only one renewing base plan can be legacy compatible')
      const oldPlans = (old?.basePlans as Json[]) ?? []
      if (mask.includes('basePlans')) {
        for (const o of oldPlans) {
          const n = plans.find((pl) => pl.basePlanId === o.basePlanId)
          if (!n)
            return this.error(
              400,
              'INVALID_ARGUMENT',
              `Base plan ${o.basePlanId as string} cannot be removed`,
            )
          if (typeOf(n)?.billingPeriodDuration !== typeOf(o)?.billingPeriodDuration)
            return this.error(400, 'INVALID_ARGUMENT', 'billingPeriodDuration is immutable')
        }
      }
      const states = new Map(oldPlans.map((o) => [o.basePlanId, o.state]))
      const next: Json = {
        packageName: this.packageName,
        productId: id,
        listings: mask.includes('listings') ? body.listings : old?.listings,
        basePlans: mask.includes('basePlans')
          ? plans.map((pl) => ({ ...pl, state: states.get(pl.basePlanId) ?? 'DRAFT' }))
          : oldPlans,
      }
      if (!Array.isArray(next.listings) || next.listings.length === 0)
        return this.error(400, 'INVALID_ARGUMENT', 'listings must include the default language')
      this.subscriptions.set(id, next)
      return json(next)
    }
    if (route('POST', /^subscriptions\/([^/]+)\/basePlans\/([^/]+):activate$/)) {
      if (this.noBilling) return this.error(403, 'PERMISSION_DENIED', 'merchant account required')
      const plan = ((this.subscriptions.get(m![1]!)?.basePlans as Json[]) ?? []).find(
        (pl) => pl.basePlanId === m![2],
      )
      if (!plan) return this.error(404, 'NOT_FOUND', 'no base plan')
      const b = req.body as Json
      if (b?.packageName !== this.packageName || b?.productId !== m![1] || b?.basePlanId !== m![2])
        return this.error(400, 'INVALID_ARGUMENT', 'package, product and base plan are required in the body')
      plan.state = 'ACTIVE'
      return json(this.subscriptions.get(m![1]!))
    }
    // offers.create: POST …/offers?offerId=…; an existing id is a conflict, never an update.
    if (route('POST', /^subscriptions\/([^/]+)\/basePlans\/([^/]+)\/offers$/)) {
      const [, sub, plan] = m!
      const offerId = req.query.get('offerId')
      if (!offerId) return this.error(400, 'INVALID_ARGUMENT', 'offerId is required')
      const base = ((this.subscriptions.get(sub!)?.basePlans as Json[]) ?? []).find(
        (pl) => pl.basePlanId === plan,
      )
      if (!base) return this.error(404, 'NOT_FOUND', 'no base plan')
      if (req.query.get('regionsVersion.version') !== this.regionVersion)
        return this.error(400, 'INVALID_ARGUMENT', 'Invalid regions version')
      const key = `${sub}/${plan}/${offerId}`
      if (this.offers.has(key)) return this.error(409, 'ALREADY_EXISTS', `offer ${offerId} already exists`)
      const b = req.body as Json
      const regions = ((b.regionalConfigs as Json[]) ?? [])
        .map((r) => String(r.regionCode))
        .sort((a, b) => a.localeCompare(b))
      for (const ph of (b.phases as Json[]) ?? []) {
        const got = ((ph.regionalConfigs as Json[]) ?? [])
          .map((r) => String(r.regionCode))
          .sort((a, b) => a.localeCompare(b))
        if (JSON.stringify(got) !== JSON.stringify(regions))
          return this.error(
            400,
            'INVALID_ARGUMENT',
            'phase regional configs must match the offer regional configs',
          )
      }
      if (!regions.length || !(b.phases as Json[])?.length)
        return this.error(400, 'INVALID_ARGUMENT', 'regionalConfigs and phases are required')
      const offer = { ...b, offerId, state: 'DRAFT' }
      this.offers.set(key, offer)
      return json(offer)
    }
    if (route('POST', /^subscriptions\/([^/]+)\/basePlans\/([^/]+)\/offers\/([^/]+):activate$/)) {
      const offer = this.offers.get(`${m![1]}/${m![2]}/${m![3]}`)
      if (!offer) return this.error(404, 'NOT_FOUND', 'no offer')
      offer.state = 'ACTIVE'
      return json(offer)
    }
    return undefined
  }

  private convert(price: string) {
    const usd = Number(price)
    const configs = [
      { regionCode: 'US', price: money(price), availability: 'AVAILABLE' },
      { regionCode: 'DE', price: money((usd * 0.95 * this.fx).toFixed(2), 'EUR'), availability: 'AVAILABLE' },
      {
        regionCode: 'JP',
        price: money(String(Math.round(usd * 150 * this.fx)), 'JPY'),
        availability: 'AVAILABLE',
      },
    ]
    return { configs }
  }

  handle(req: Req): Response {
    let m: RegExpMatchArray | null
    if (req.auth !== 'Bearer ya29.fake-token') return this.error(401, 'UNAUTHENTICATED', 'bad token')
    const p = req.path
    if (!p.startsWith(`applications/${this.packageName}/`))
      return this.error(404, 'NOT_FOUND', 'Package not found')
    const rest = p.slice(`applications/${this.packageName}/`.length)
    if (req.method === 'GET' && rest === 'oneTimeProducts') {
      const all = [...this.products.values()]
      const start = Number(req.query.get('pageToken') ?? 0)
      const items = all.slice(start, start + this.pageSize)
      const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined
      return json({ oneTimeProducts: items, ...(next ? { nextPageToken: next } : {}) })
    }
    if (req.method === 'POST' && rest === 'pricing:convertRegionPrices') {
      this.convertCalls++
      const price = (req.body as { price: Money }).price
      const s = moneyNumber(price).toFixed(2)
      const regions = Object.fromEntries(
        this.convert(s).configs.map((c) => [
          c.regionCode,
          { regionCode: c.regionCode, price: c.price, taxAmount: money('0.00', c.price.currencyCode) },
        ]),
      )
      return json({
        convertedRegionPrices: regions,
        convertedOtherRegionsPrice: { usdPrice: money(s), eurPrice: money(s, 'EUR') },
        regionVersion: { version: this.regionVersion },
      })
    }
    if (req.method === 'PATCH' && (m = rest.match(/^oneTimeProducts\/(.+)$/))) {
      return this.error(404, 'NOT_FOUND', 'the PATCH path is lowercase onetimeproducts')
    }
    if (req.method === 'PATCH' && (m = rest.match(/^onetimeproducts\/([^/]+)$/))) {
      const id = m[1]!
      if (this.failPatch.has(id)) {
        return new Response(
          JSON.stringify({
            error: { code: 500, status: 'INTERNAL', message: 'Internal error encountered.' },
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json', 'retry-after': '0' },
          },
        )
      }
      if (!req.query.get('updateMask')) return this.error(400, 'INVALID_ARGUMENT', 'updateMask is required')
      if (req.query.get('regionsVersion.version') !== this.regionVersion) {
        return this.error(
          400,
          'INVALID_ARGUMENT',
          `Invalid regions version ${req.query.get('regionsVersion.version')}, latest value is ExternalRegionLaunchVersionId{versionId=${this.regionVersion}}`,
        )
      }
      const exists = this.products.has(id)
      if (!exists && req.query.get('allowMissing') !== 'true')
        return this.error(404, 'NOT_FOUND', 'no product')
      const body = req.body as Json
      if (body.productId !== id || body.packageName !== this.packageName) {
        return this.error(400, 'INVALID_ARGUMENT', 'productId/packageName must match the path')
      }
      const options = (body.purchaseOptions as Json[]) ?? []
      for (const o of options)
        if ('state' in o) return this.error(400, 'INVALID_ARGUMENT', 'state is output only')
      if (options.filter((o) => (o.buyOption as Json | undefined)?.legacyCompatible).length > 1) {
        return this.error(400, 'INVALID_ARGUMENT', 'Up to one buy purchase option can be legacy compatible')
      }
      const old = this.products.get(id)
      const oldOptions = ((old?.purchaseOptions as Json[]) ?? []).map(
        (o) => [o.purchaseOptionId, o.state] as const,
      )
      for (const [oid] of oldOptions) {
        if (!options.some((o) => o.purchaseOptionId === oid)) {
          return this.error(400, 'INVALID_ARGUMENT', `Purchase option ${oid as string} cannot be removed`)
        }
      }
      const states = new Map(oldOptions)
      const product = {
        ...body,
        purchaseOptions: options.map((o) => ({
          ...o,
          state: states.get(o.purchaseOptionId as string) ?? 'DRAFT',
        })),
        regionsVersion: { version: this.regionVersion },
      }
      this.products.set(id, product)
      return json(product)
    }
    if (
      req.method === 'POST' &&
      (m = rest.match(/^oneTimeProducts\/([^/]+)\/purchaseOptions:batchUpdateStates$/))
    ) {
      const out: Json[] = []
      for (const r of (req.body as { requests: Json[] }).requests) {
        const a = r.activatePurchaseOptionRequest as Json | undefined
        if (!a) return this.error(400, 'INVALID_ARGUMENT', 'only activation in the fake')
        const prod = this.products.get(a.productId as string)
        const opt = ((prod?.purchaseOptions as Json[]) ?? []).find(
          (o) => o.purchaseOptionId === a.purchaseOptionId,
        )
        if (!prod || !opt) return this.error(404, 'NOT_FOUND', 'no purchase option')
        if (a.packageName !== this.packageName) return this.error(400, 'INVALID_ARGUMENT', 'packageName')
        opt.state = 'ACTIVE'
        out.push(prod)
      }
      return json({ oneTimeProducts: out })
    }
    const sub = this.subscriptionRoute(req, rest)
    if (sub) return sub
    if (
      req.method === 'DELETE' ||
      rest.includes('migratePrices') ||
      rest.includes(':batchDelete') ||
      rest.includes('deactivate')
    ) {
      return this.error(500, 'FAKE', 'kit must never delete or deactivate')
    }
    return this.error(404, 'NOT_FOUND', `fake Play: no route ${req.method} ${p}`)
  }
}

// ---- RevenueCat -----------------------------------------------------------------------------------
