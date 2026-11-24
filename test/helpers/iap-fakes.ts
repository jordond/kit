/**
 * Stateful stand-ins for App Store Connect, Google Play and RevenueCat: in-memory catalogs that
 * writes change and reads report, in each store's own JSON shapes (plan-4 research notes). One
 * Bun server serves all three under prefixes: `/asc`, `/play` (+ `/token`) and `/rc/v2`.
 */

export interface Req {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  auth: string
}

type Json = Record<string, unknown>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ---- App Store Connect ----------------------------------------------------------------------------

interface AscIap {
  id: string
  name: string
  productId: string
  inAppPurchaseType: string
  reviewNote: string | null
  familySharable: boolean
  approved?: boolean
  versions: string[]
  availability?: string
  screenshot?: string
  schedule?: string
}

/** USA customer prices Apple offers in the fake: 0.99 … 99.99 and a few round ones. */
const ASC_PRICES = [...Array.from({ length: 100 }, (_, i) => `${i}.99`), '1.49', '2.49', '100.0', '499.0']

export class FakeAsc {
  bundleId = 'app.example'
  appId = '6446148572'
  /** Apple creates a draft version with the IAP (unverified upstream; both are tested). */
  autoDraftVersion = false
  /** Page size the fake uses regardless of `limit`, to exercise `links.next`. */
  pageSize = 2
  iaps = new Map<string, AscIap>()
  versions = new Map<string, { iap: string; state: string }>()
  localizations = new Map<
    string,
    { version: string; locale: string; name: string; description: string | null }
  >()
  manualPrices = new Map<string, { startDate: string | null; endDate: string | null; price: string }[]>()
  availabilities = new Map<string, { territories: string[]; availableInNewTerritories: boolean }>()
  screenshots = new Map<
    string,
    {
      iap: string
      fileName: string
      fileSize: number
      checksum: string | null
      state: string
      bytes: number
    }
  >()
  territories = ['USA', 'CAN', 'GBR', 'DEU', 'JPN']
  private seq = 1000
  constructor(readonly origin: () => string) {}

  private nextId(): string {
    return String(++this.seq)
  }

  /** An IAP as if made in the console (for "in sync" / "differs" / "extra" seeds). */
  seed(attrs: {
    productId: string
    name?: string
    type?: string
    reviewNote?: string
    familySharable?: boolean
    approved?: boolean
    localizations?: Record<string, { name: string; description: string }>
    versionState?: string
    prices?: { startDate: string | null; price: string }[]
    availability?: boolean
    screenshot?: { fileName: string; fileSize: number; checksum: string; state?: string }
  }): string {
    const id = this.nextId()
    const iap: AscIap = {
      id,
      name: attrs.name ?? attrs.productId,
      productId: attrs.productId,
      inAppPurchaseType: attrs.type ?? 'NON_CONSUMABLE',
      reviewNote: attrs.reviewNote ?? null,
      familySharable: attrs.familySharable ?? false,
      approved: attrs.approved,
      versions: [],
    }
    this.iaps.set(id, iap)
    if (attrs.localizations) {
      const v = this.nextId()
      this.versions.set(v, { iap: id, state: attrs.versionState ?? 'PREPARE_FOR_SUBMISSION' })
      iap.versions.push(v)
      for (const [locale, l] of Object.entries(attrs.localizations)) {
        this.localizations.set(this.nextId(), { version: v, locale, ...l })
      }
    }
    if (attrs.prices) {
      iap.schedule = id
      this.manualPrices.set(
        id,
        attrs.prices.map((p) => ({ ...p, endDate: null })),
      )
    }
    if (attrs.availability) {
      iap.availability = id
      this.availabilities.set(id, { territories: this.territories, availableInNewTerritories: true })
    }
    if (attrs.screenshot) {
      const s = this.nextId()
      iap.screenshot = s
      this.screenshots.set(s, {
        iap: id,
        ...attrs.screenshot,
        state: attrs.screenshot.state ?? 'COMPLETE',
        bytes: 0,
      })
    }
    return id
  }

  byProductId(productId: string): AscIap | undefined {
    return [...this.iaps.values()].find((i) => i.productId === productId)
  }

  private state(iap: AscIap): string {
    if (iap.approved) return 'APPROVED'
    const locs = [...this.localizations.values()].filter((l) => iap.versions.includes(l.version))
    const ready = locs.length && iap.schedule && iap.availability && iap.screenshot
    return ready ? 'READY_TO_SUBMIT' : 'MISSING_METADATA'
  }

  private page<T>(items: T[], req: Req, path: string): { items: T[]; next?: string } {
    const start = Number(req.query.get('cursor') ?? 0)
    const items_ = items.slice(start, start + this.pageSize)
    if (start + this.pageSize >= items.length) return { items: items_ }
    const q = new URLSearchParams(req.query)
    q.set('cursor', String(start + this.pageSize))
    return { items: items_, next: `${this.origin()}/asc/${path}?${q}` }
  }

  private iapJson(iap: AscIap) {
    return {
      type: 'inAppPurchases',
      id: iap.id,
      attributes: {
        name: iap.name,
        productId: iap.productId,
        inAppPurchaseType: iap.inAppPurchaseType,
        state: this.state(iap),
        reviewNote: iap.reviewNote,
        familySharable: iap.familySharable,
      },
      relationships: {
        versions: { data: iap.versions.map((id) => ({ type: 'inAppPurchaseVersions', id })) },
        inAppPurchaseAvailability: {
          data: iap.availability ? { type: 'inAppPurchaseAvailabilities', id: iap.availability } : null,
        },
        appStoreReviewScreenshot: {
          data: iap.screenshot
            ? { type: 'inAppPurchaseAppStoreReviewScreenshots', id: iap.screenshot }
            : null,
        },
        iapPriceSchedule: {
          data: iap.schedule ? { type: 'inAppPurchasePriceSchedules', id: iap.schedule } : null,
        },
      },
    }
  }

  private screenshotJson(id: string) {
    const s = this.screenshots.get(id)!
    return {
      type: 'inAppPurchaseAppStoreReviewScreenshots',
      id,
      attributes: {
        fileName: s.fileName,
        fileSize: s.fileSize,
        sourceFileChecksum: s.checksum,
        assetDeliveryState: { state: s.state, errors: [] },
        uploadOperations:
          s.state === 'AWAITING_UPLOAD'
            ? [
                {
                  method: 'PUT',
                  url: `${this.origin()}/upload/${id}`,
                  offset: 0,
                  length: s.fileSize,
                  requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
                },
              ]
            : null,
      },
    }
  }

  private error(status: number, code: string, detail: string) {
    return json({ errors: [{ status: String(status), code, title: code, detail }] }, status)
  }

  handle(req: Req): Response {
    const p = req.path
    const body = req.body as { data: Json & { attributes?: Json; relationships?: Json }; included?: Json[] }
    let m: RegExpMatchArray | null
    if (!req.auth.startsWith('Bearer ')) return this.error(401, 'NOT_AUTHORIZED', 'no token')

    if (req.method === 'GET' && p === 'v1/apps') {
      const match = req.query.get('filter[bundleId]') === this.bundleId
      return json({
        data: match ? [{ type: 'apps', id: this.appId, attributes: { bundleId: this.bundleId } }] : [],
      })
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/apps\/(\w+)\/inAppPurchasesV2$/))) {
      const { items, next } = this.page([...this.iaps.values()], req, p)
      const include = (req.query.get('include') ?? '').split(',')
      const included: unknown[] = []
      for (const iap of items) {
        if (include.includes('versions')) {
          for (const v of iap.versions) {
            included.push({
              type: 'inAppPurchaseVersions',
              id: v,
              attributes: { state: this.versions.get(v)!.state },
            })
          }
        }
        if (include.includes('appStoreReviewScreenshot') && iap.screenshot)
          included.push(this.screenshotJson(iap.screenshot))
      }
      return json({ data: items.map((i) => this.iapJson(i)), included, links: { self: '', next } })
    }
    if (req.method === 'GET' && (m = p.match(/^v2\/inAppPurchases\/(\w+)\/versions$/))) {
      const iap = this.iaps.get(m[1]!)
      if (!iap) return this.error(404, 'NOT_FOUND', 'no iap')
      return json({
        data: iap.versions.map((id) => ({
          type: 'inAppPurchaseVersions',
          id,
          attributes: { state: this.versions.get(id)!.state },
        })),
        links: {},
      })
    }
    if (req.method === 'POST' && p === 'v1/inAppPurchaseVersions') {
      const iapId = ((body.data.relationships!.inAppPurchase as Json).data as Json).id as string
      const iap = this.iaps.get(iapId)!
      if (iap.versions.some((v) => this.versions.get(v)!.state === 'PREPARE_FOR_SUBMISSION')) {
        return this.error(409, 'STATE_ERROR', 'a draft version exists')
      }
      const id = this.nextId()
      // A new version starts with the latest version's localizations.
      const latest = iap.versions.at(-1)
      for (const l of [...this.localizations.values()].filter((x) => x.version === latest)) {
        this.localizations.set(this.nextId(), { ...l, version: id })
      }
      this.versions.set(id, { iap: iapId, state: 'PREPARE_FOR_SUBMISSION' })
      iap.versions.push(id)
      return json(
        { data: { type: 'inAppPurchaseVersions', id, attributes: { state: 'PREPARE_FOR_SUBMISSION' } } },
        201,
      )
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/inAppPurchaseVersions\/(\w+)\/localizations$/))) {
      const data = [...this.localizations.entries()]
        .filter(([, l]) => l.version === m![1])
        .map(([id, l]) => ({
          type: 'inAppPurchaseLocalizations',
          id,
          attributes: {
            locale: l.locale,
            name: l.name,
            description: l.description,
            state: 'PREPARE_FOR_SUBMISSION',
          },
        }))
      return json({ data, links: {} })
    }
    if (req.method === 'POST' && p === 'v2/inAppPurchaseLocalizations') {
      const a = body.data.attributes!
      const version = ((body.data.relationships!.version as Json).data as Json).id as string
      if (!this.versions.has(version)) return this.error(404, 'NOT_FOUND', 'no version')
      const id = this.nextId()
      this.localizations.set(id, {
        version,
        locale: a.locale as string,
        name: a.name as string,
        description: (a.description as string) ?? null,
      })
      return json({ data: { type: 'inAppPurchaseLocalizations', id } }, 201)
    }
    if (req.method === 'PATCH' && (m = p.match(/^v2\/inAppPurchaseLocalizations\/(\w+)$/))) {
      const l = this.localizations.get(m[1]!)!
      const a = body.data.attributes!
      if ('locale' in a) return this.error(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', 'locale is not editable')
      Object.assign(l, a)
      return json({ data: { type: 'inAppPurchaseLocalizations', id: m[1] } })
    }
    if (req.method === 'POST' && p === 'v2/inAppPurchases') {
      const a = body.data.attributes!
      if (this.byProductId(a.productId as string)) {
        return this.error(
          409,
          'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE',
          'This product ID has already been used',
        )
      }
      const id = this.nextId()
      const iap: AscIap = {
        id,
        name: a.name as string,
        productId: a.productId as string,
        inAppPurchaseType: a.inAppPurchaseType as string,
        reviewNote: (a.reviewNote as string) ?? null,
        familySharable: (a.familySharable as boolean) ?? false,
        versions: [],
      }
      this.iaps.set(id, iap)
      if (this.autoDraftVersion) {
        const v = this.nextId()
        this.versions.set(v, { iap: id, state: 'PREPARE_FOR_SUBMISSION' })
        iap.versions.push(v)
      }
      return json({ data: this.iapJson(iap) }, 201)
    }
    if (req.method === 'PATCH' && (m = p.match(/^v2\/inAppPurchases\/(\w+)$/))) {
      const iap = this.iaps.get(m[1]!)!
      const a = body.data.attributes!
      for (const k of Object.keys(a)) {
        if (!['name', 'reviewNote', 'familySharable'].includes(k)) {
          return this.error(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', `${k} is not editable`)
        }
      }
      if (iap.familySharable && a.familySharable === false) {
        return this.error(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', 'Family Sharing cannot be turned off')
      }
      Object.assign(iap, a)
      return json({ data: this.iapJson(iap) })
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/inAppPurchasePriceSchedules\/(\w+)\/manualPrices$/))) {
      const prices = this.manualPrices.get(m[1]!) ?? []
      const iapId = [...this.iaps.values()].find((i) => i.schedule === m![1])!.id
      return json({
        data: prices.map((pr, i) => ({
          type: 'inAppPurchasePrices',
          id: `mp-${m![1]}-${i}`,
          attributes: { startDate: pr.startDate, endDate: pr.endDate, manual: true },
          relationships: {
            inAppPurchasePricePoint: {
              data: { type: 'inAppPurchasePricePoints', id: `pp-${iapId}-${pr.price}` },
            },
          },
        })),
        included: prices.map((pr) => ({
          type: 'inAppPurchasePricePoints',
          id: `pp-${iapId}-${pr.price}`,
          attributes: { customerPrice: pr.price, proceeds: '0' },
        })),
        links: {},
      })
    }
    if (req.method === 'GET' && (m = p.match(/^v2\/inAppPurchases\/(\w+)\/pricePoints$/))) {
      if (req.query.get('filter[territory]') !== 'USA') return this.error(400, 'PARAMETER_ERROR', 'territory')
      return json({
        data: ASC_PRICES.map((price) => ({
          type: 'inAppPurchasePricePoints',
          id: `pp-${m![1]}-${price}`,
          attributes: { customerPrice: price },
        })),
        links: {},
      })
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/apps\/(\w+)\/appPricePoints$/))) {
      return json({
        data: ASC_PRICES.map((price) => ({
          type: 'appPricePoints',
          id: `app-${price}`,
          attributes: { customerPrice: price },
        })),
        links: {},
      })
    }
    if (req.method === 'POST' && p === 'v1/inAppPurchasePriceSchedules') {
      const rel = body.data.relationships!
      const iapId = ((rel.inAppPurchase as Json).data as Json).id as string
      const iap = this.iaps.get(iapId)!
      if (((rel.baseTerritory as Json).data as Json).id !== 'USA')
        return this.error(409, 'ENTITY_ERROR', 'base')
      const ids = ((rel.manualPrices as Json).data as Json[]).map((d) => d.id)
      const prices: { startDate: string | null; endDate: string | null; price: string }[] = []
      for (const inc of body.included ?? []) {
        if (!ids.includes(inc.id)) return this.error(409, 'ENTITY_ERROR.INCLUDED', 'not referenced')
        const point = (((inc.relationships as Json).inAppPurchasePricePoint as Json).data as Json)
          .id as string
        const prefix = `pp-${iapId}-`
        if (!point.startsWith(prefix)) return this.error(404, 'ENTITY_ERROR.NOT_FOUND', 'unknown price point')
        prices.push({
          startDate: ((inc.attributes as Json).startDate as string) ?? null,
          endDate: null,
          price: point.slice(prefix.length),
        })
      }
      if (!prices.some((x) => x.startDate === null))
        return this.error(409, 'ENTITY_ERROR.INVALID_START_DATE', 'timeline')
      iap.schedule = iapId
      this.manualPrices.set(iapId, prices)
      return json({ data: { type: 'inAppPurchasePriceSchedules', id: iapId } }, 201)
    }
    if (req.method === 'GET' && p === 'v1/territories') {
      const { items, next } = this.page(this.territories, req, p)
      return json({
        data: items.map((id) => ({ type: 'territories', id, attributes: { currency: 'USD' } })),
        links: { next },
      })
    }
    if (req.method === 'POST' && p === 'v1/inAppPurchaseAvailabilities') {
      const rel = body.data.relationships!
      const iapId = ((rel.inAppPurchase as Json).data as Json).id as string
      const iap = this.iaps.get(iapId)!
      iap.availability = iapId
      this.availabilities.set(iapId, {
        territories: ((rel.availableTerritories as Json).data as Json[]).map((t) => t.id as string),
        availableInNewTerritories: body.data.attributes!.availableInNewTerritories as boolean,
      })
      return json({ data: { type: 'inAppPurchaseAvailabilities', id: iapId } }, 201)
    }
    if (req.method === 'POST' && p === 'v1/inAppPurchaseAppStoreReviewScreenshots') {
      const iapId = ((body.data.relationships!.inAppPurchaseV2 as Json).data as Json).id as string
      const iap = this.iaps.get(iapId)!
      if (iap.screenshot) return this.error(409, 'STATE_ERROR', 'a screenshot exists')
      const id = this.nextId()
      const a = body.data.attributes!
      this.screenshots.set(id, {
        iap: iapId,
        fileName: a.fileName as string,
        fileSize: a.fileSize as number,
        checksum: null,
        state: 'AWAITING_UPLOAD',
        bytes: 0,
      })
      iap.screenshot = id
      return json({ data: this.screenshotJson(id) }, 201)
    }
    if (req.method === 'PATCH' && (m = p.match(/^v1\/inAppPurchaseAppStoreReviewScreenshots\/(\w+)$/))) {
      const s = this.screenshots.get(m[1]!)!
      const a = body.data.attributes!
      if (a.uploaded) {
        s.checksum = a.sourceFileChecksum as string
        s.state = s.bytes === s.fileSize ? 'UPLOAD_COMPLETE' : 'FAILED'
      }
      return json({ data: this.screenshotJson(m[1]!) })
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/inAppPurchaseAppStoreReviewScreenshots\/(\w+)$/))) {
      const s = this.screenshots.get(m[1]!)!
      if (s.state === 'UPLOAD_COMPLETE') s.state = 'COMPLETE'
      return json({ data: this.screenshotJson(m[1]!) })
    }
    if (req.method === 'DELETE') return this.error(500, 'FAKE', 'kit must never delete')
    return this.error(404, 'NOT_FOUND', `fake ASC: no route ${req.method} ${p}`)
  }

  upload(id: string, bytes: number, auth: string): Response {
    if (auth) return new Response('no auth on upload URLs', { status: 400 })
    const s = this.screenshots.get(id)
    if (!s) return new Response('no reservation', { status: 404 })
    s.bytes += bytes
    return new Response(null, { status: 200 })
  }
}

// ---- Google Play ----------------------------------------------------------------------------------

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
      if (this.failPatch.has(id)) return this.error(500, 'INTERNAL', 'Internal error encountered.')
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

export class FakeRc {
  projectId = 'projd2d1fc4a'
  key = 'sk_fake_key'
  pageSize = 2
  apps: Json[] = [
    {
      object: 'app',
      id: 'app_ios',
      name: 'iOS',
      type: 'app_store',
      project_id: 'projd2d1fc4a',
      app_store: { bundle_id: 'app.example' },
    },
    {
      object: 'app',
      id: 'app_play',
      name: 'Android',
      type: 'play_store',
      project_id: 'projd2d1fc4a',
      play_store: { package_name: 'app.example' },
    },
  ]
  products = new Map<string, Json>()
  entitlements = new Map<string, Json>()
  attached = new Map<string, Set<string>>()
  private seq = 0

  private error(status: number, type: string, message: string) {
    return json({ object: 'error', type, message, retryable: false }, status)
  }

  private list(items: Json[], req: Req, path: string) {
    const after = req.query.get('starting_after')
    const start = after ? items.findIndex((i) => i.id === after) + 1 : 0
    const page = items.slice(start, start + this.pageSize)
    const more = start + this.pageSize < items.length
    return json({
      object: 'list',
      items: page,
      url: `/v2/${path}`,
      next_page: more
        ? `/v2/${path}?starting_after=${page.at(-1)!.id as string}&limit=${this.pageSize}`
        : null,
    })
  }

  seedProduct(
    app: string,
    storeIdentifier: string,
    type: string,
    displayName: string,
    state = 'active',
  ): string {
    const id = `prod${++this.seq}`
    this.products.set(id, {
      object: 'product',
      id,
      store_identifier: storeIdentifier,
      type,
      state,
      app_id: app,
      display_name: displayName,
      created_at: 1,
    })
    return id
  }

  seedEntitlement(lookupKey: string, products: string[] = [], state = 'active'): string {
    const id = `entl${++this.seq}`
    this.entitlements.set(id, {
      object: 'entitlement',
      id,
      lookup_key: lookupKey,
      display_name: lookupKey,
      project_id: this.projectId,
      state,
      created_at: 1,
    })
    this.attached.set(id, new Set(products))
    return id
  }

  handle(req: Req): Response {
    let m: RegExpMatchArray | null
    if (req.auth !== `Bearer ${this.key}`) return this.error(401, 'authentication_error', 'Invalid API key')
    const prefix = `projects/${this.projectId}/`
    if (!req.path.startsWith(prefix)) return this.error(404, 'resource_missing', 'Project not found')
    const p = req.path.slice(prefix.length)
    const body = (req.body ?? {}) as Json
    if (req.method === 'GET' && p === 'apps') return this.list(this.apps, req, `${prefix}apps`)
    if (req.method === 'GET' && p === 'products')
      return this.list([...this.products.values()], req, `${prefix}products`)
    if (req.method === 'POST' && p === 'products') {
      for (const k of ['store_identifier', 'app_id', 'type']) {
        if (!body[k]) return this.error(400, 'parameter_error', `${k} is required`)
      }
      if (!this.apps.some((a) => a.id === body.app_id))
        return this.error(404, 'resource_missing', 'App not found')
      if (
        [...this.products.values()].some(
          (x) => x.app_id === body.app_id && x.store_identifier === body.store_identifier,
        )
      ) {
        return this.error(409, 'resource_already_exists', 'Product already exists')
      }
      const id = this.seedProduct(
        body.app_id as string,
        body.store_identifier as string,
        body.type as string,
        (body.display_name as string) ?? '',
      )
      return json(this.products.get(id), 201)
    }
    if (req.method === 'POST' && (m = p.match(/^products\/(\w+)$/))) {
      const prod = this.products.get(m[1]!)
      if (!prod) return this.error(404, 'resource_missing', 'Product not found')
      for (const k of Object.keys(body)) {
        if (!['display_name', 'type'].includes(k))
          return this.error(400, 'parameter_error', `${k} cannot be updated`)
      }
      Object.assign(prod, body)
      return json(prod)
    }
    if (req.method === 'GET' && p === 'entitlements')
      return this.list([...this.entitlements.values()], req, `${prefix}entitlements`)
    if (req.method === 'POST' && p === 'entitlements') {
      if ([...this.entitlements.values()].some((e) => e.lookup_key === body.lookup_key)) {
        return this.error(409, 'resource_already_exists', 'Entitlement already exists')
      }
      const id = this.seedEntitlement(body.lookup_key as string)
      this.entitlements.get(id)!.display_name = body.display_name
      return json(this.entitlements.get(id), 201)
    }
    if (req.method === 'GET' && (m = p.match(/^entitlements\/(\w+)\/products$/))) {
      const set = this.attached.get(m[1]!)
      if (!set) return this.error(404, 'resource_missing', 'Entitlement not found')
      return this.list(
        [...set].map((id) => this.products.get(id)!),
        req,
        `${prefix}entitlements/${m[1]}/products`,
      )
    }
    if (req.method === 'POST' && (m = p.match(/^entitlements\/(\w+)\/actions\/attach_products$/))) {
      const set = this.attached.get(m[1]!)
      if (!set) return this.error(404, 'resource_missing', 'Entitlement not found')
      const ids = body.product_ids as string[]
      if (!ids?.length || ids.length > 50) return this.error(400, 'parameter_error', 'product_ids: 1-50')
      for (const id of ids) {
        const prod = this.products.get(id)
        if (!prod) return this.error(404, 'resource_missing', `Product ${id} not found`)
        if (prod.state === 'inactive')
          return this.error(422, 'entity_references_archived_entities', 'archived product')
      }
      for (const id of ids) set.add(id)
      return json(this.entitlements.get(m[1]!))
    }
    if (req.method === 'DELETE' || p.includes('detach') || p.includes('archive')) {
      return this.error(500, 'server_error', 'kit must never delete, detach or archive')
    }
    return this.error(404, 'resource_missing', `fake RC: no route ${req.method} ${p}`)
  }
}

// ---- server ---------------------------------------------------------------------------------------

export interface Fakes {
  asc: FakeAsc
  play: FakePlay
  rc: FakeRc
  /** Every request, in order. */
  log: Req[]
  writes(store?: 'asc' | 'play' | 'rc'): Req[]
  env(): Record<string, string>
  stop(): void
}

export function startFakes(): Fakes {
  const log: (Req & { store: 'asc' | 'play' | 'rc' | 'token' | 'upload' })[] = []
  let origin = ''
  const asc = new FakeAsc(() => origin)
  const play = new FakePlay()
  const rc = new FakeRc()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === 'PUT' ? '' : await request.text()
      let body: unknown
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = text
      }
      const auth = request.headers.get('authorization') ?? ''
      const at = (prefix: string) => url.pathname.slice(prefix.length).replace(/^\/+/, '')
      if (url.pathname === '/token') {
        log.push({
          store: 'token',
          method: request.method,
          path: 'token',
          query: url.searchParams,
          body: text,
          auth,
        })
        return json({ access_token: 'ya29.fake-token', expires_in: 3600, token_type: 'Bearer' })
      }
      if (url.pathname.startsWith('/upload/')) {
        const bytes = (await request.arrayBuffer()).byteLength
        log.push({
          store: 'upload',
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          body: bytes,
          auth,
        })
        return asc.upload(url.pathname.slice('/upload/'.length), bytes, auth)
      }
      for (const [prefix, store, fake] of [
        ['/asc', 'asc', asc],
        ['/play', 'play', play],
        ['/rc/v2', 'rc', rc],
      ] as const) {
        if (url.pathname.startsWith(`${prefix}/`)) {
          const req = { method: request.method, path: at(prefix), query: url.searchParams, body, auth }
          log.push({ store, ...req })
          return fake.handle(req)
        }
      }
      return new Response('no such fake', { status: 404 })
    },
  })
  origin = `http://localhost:${server.port}`
  return {
    asc,
    play,
    rc,
    log,
    writes: (store) =>
      log.filter((r) => r.method !== 'GET' && (!store || r.store === store) && r.store !== 'token'),
    env: () => ({
      KIT_ASC_API_URL: `${origin}/asc`,
      KIT_PLAY_API_URL: `${origin}/play`,
      KIT_GOOGLE_TOKEN_URL: `${origin}/token`,
      KIT_RC_API_URL: `${origin}/rc/v2`,
    }),
    stop: () => server.stop(true),
  }
}
