import { FakeAscSubscriptions } from './asc-subscriptions'
import { type Json, json, type Req } from './common'

// Stateful App Store Connect fake: in-memory catalog that writes change and reads report.

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
  /** Auto-renewable subscriptions: groups, plans, prices, offers (own file). */
  readonly subs: FakeAscSubscriptions = new FakeAscSubscriptions(this)
  constructor(readonly origin: () => string) {}

  nextId(): string {
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

  page<T>(items: T[], req: Req, path: string): { items: T[]; next?: string } {
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

  screenshotJson(id: string) {
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

  error(status: number, code: string, detail: string) {
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
    const sub = this.subs.handle(req)
    if (sub) return sub
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
