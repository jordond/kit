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
    if (req.method === 'DELETE' || rest.includes(':batchDelete') || rest.includes('deactivate')) {
      return this.error(500, 'FAKE', 'kit must never delete or deactivate')
    }
    return this.error(404, 'NOT_FOUND', `fake Play: no route ${req.method} ${p}`)
  }
}

// ---- RevenueCat -----------------------------------------------------------------------------------
