import type { FakeAsc } from './asc'
import { type Json, json, type Req } from './common'

/**
 * Subscriptions half of the App Store Connect fake: groups, subscriptions, their versions and
 * localizations, USA price points with equalizations, per-territory prices, availability,
 * introductory offers and review screenshots. Stateful like `FakeAsc`, which delegates to it.
 * Switches force the shapes research could not settle (`bulkPricePatch`, `planAvailability`).
 */

interface Group {
  id: string
  referenceName: string
  versions: string[]
}

interface Sub {
  id: string
  group: string
  name: string
  productId: string
  subscriptionPeriod: string
  groupLevel: number
  familySharable: boolean
  reviewNote: string | null
  approved?: boolean
  versions: string[]
  availability?: 'plan' | 'legacy'
  screenshot?: string
}

export interface SubPrice {
  territory: string
  point: string
  customerPrice: string
  startDate: string | null
  preserved: boolean
}

export interface SubOffer {
  sub: string
  territory: string
  duration: string
  offerMode: string
  numberOfPeriods: number
  endDate: string | null
}

/** Equalized USD → local price: only the shape matters. */
const RATE: Record<string, number> = { USA: 1, CAN: 1.3, GBR: 0.8, DEU: 0.9, JPN: 150 }
const equalized = (territory: string, usa: string): string =>
  (Number(usa) * (RATE[territory] ?? 1)).toFixed(2)
const USA_PRICES = [...Array.from({ length: 100 }, (_, i) => `${i}.99`), '1.49', '2.49', '100.0', '499.0']

interface Versioned {
  /** Collection name in the API: `subscriptions` or `subscriptionGroups`. */
  parent: 'subscriptions' | 'subscriptionGroups'
  versionType: string
  localizationType: string
}
const VERSIONED: Versioned[] = [
  {
    parent: 'subscriptions',
    versionType: 'subscriptionVersions',
    localizationType: 'subscriptionLocalizations',
  },
  {
    parent: 'subscriptionGroups',
    versionType: 'subscriptionGroupVersions',
    localizationType: 'subscriptionGroupLocalizations',
  },
]

export class FakeAscSubscriptions {
  /** False: `PATCH /v1/subscriptions/{id}` with inline prices is refused (409), so kit posts per territory. */
  bulkPricePatch = true
  /** False: `subscriptionPlanAvailabilities` is refused (the new endpoint is not usable), so kit uses the deprecated one. */
  planAvailability = true
  groups = new Map<string, Group>()
  subs = new Map<string, Sub>()
  versions = new Map<string, { parent: string; state: string }>()
  localizations = new Map<
    string,
    { version: string; locale: string; name: string; description: string | null }
  >()
  prices = new Map<string, SubPrice[]>()
  offers = new Map<string, SubOffer>()
  availabilities = new Map<string, { territories: string[]; availableInNewTerritories: boolean }>()

  constructor(private readonly asc: FakeAsc) {}

  // ---- seeding ----------------------------------------------------------------------------------

  seedGroup(attrs: { referenceName: string; localizations?: Record<string, string> }): string {
    const id = this.asc.nextId()
    this.groups.set(id, { id, referenceName: attrs.referenceName, versions: [] })
    if (attrs.localizations) {
      const v = this.newVersion(id, 'PREPARE_FOR_SUBMISSION')
      this.groups.get(id)!.versions.push(v)
      for (const [locale, name] of Object.entries(attrs.localizations)) {
        this.localizations.set(this.asc.nextId(), { version: v, locale, name, description: null })
      }
    }
    return id
  }

  seedSub(attrs: {
    group: string
    productId: string
    name?: string
    period?: string
    groupLevel?: number
    familySharable?: boolean
    reviewNote?: string
    approved?: boolean
    localizations?: Record<string, { name: string; description: string }>
    versionState?: string
    /** USA price; every other territory gets its equalized price. */
    price?: string
    availability?: 'plan' | 'legacy'
    offers?: { duration: string; offerMode?: string }[]
  }): string {
    const id = this.asc.nextId()
    const sub: Sub = {
      id,
      group: attrs.group,
      name: attrs.name ?? attrs.productId,
      productId: attrs.productId,
      subscriptionPeriod: attrs.period ?? 'ONE_MONTH',
      groupLevel: attrs.groupLevel ?? 1,
      familySharable: attrs.familySharable ?? false,
      reviewNote: attrs.reviewNote ?? null,
      approved: attrs.approved,
      versions: [],
    }
    this.subs.set(id, sub)
    if (attrs.localizations) {
      const v = this.newVersion(id, attrs.versionState ?? 'PREPARE_FOR_SUBMISSION')
      sub.versions.push(v)
      for (const [locale, l] of Object.entries(attrs.localizations)) {
        this.localizations.set(this.asc.nextId(), { version: v, locale, ...l })
      }
    }
    if (attrs.availability) {
      sub.availability = attrs.availability
      this.availabilities.set(id, { territories: this.asc.territories, availableInNewTerritories: true })
    }
    if (attrs.price) {
      this.prices.set(
        id,
        this.asc.territories.map((territory) => ({
          territory,
          point: `spp-${id}-${territory}-${equalized(territory, attrs.price!)}`,
          customerPrice: equalized(territory, attrs.price!),
          startDate: null,
          preserved: false,
        })),
      )
    }
    for (const o of attrs.offers ?? []) {
      this.offers.set(this.asc.nextId(), {
        sub: id,
        territory: 'USA',
        duration: o.duration,
        offerMode: o.offerMode ?? 'FREE_TRIAL',
        numberOfPeriods: 1,
        endDate: null,
      })
    }
    return id
  }

  byProductId(productId: string): Sub | undefined {
    return [...this.subs.values()].find((s) => s.productId === productId)
  }

  groupByName(referenceName: string): Group | undefined {
    return [...this.groups.values()].find((g) => g.referenceName === referenceName)
  }

  /** The USA price in effect of a subscription. */
  usaPrice(subId: string): string | undefined {
    return this.prices.get(subId)?.find((p) => p.territory === 'USA')?.customerPrice
  }

  private newVersion(parent: string, state: string): string {
    const id = this.asc.nextId()
    this.versions.set(id, { parent, state })
    return id
  }

  private state(sub: Sub): string {
    if (sub.approved) return 'APPROVED'
    const locs = [...this.localizations.values()].filter((l) => sub.versions.includes(l.version))
    return locs.length && this.prices.get(sub.id)?.length && sub.availability && sub.screenshot
      ? 'READY_TO_SUBMIT'
      : 'MISSING_METADATA'
  }

  private subJson(sub: Sub) {
    return {
      type: 'subscriptions',
      id: sub.id,
      attributes: {
        name: sub.name,
        productId: sub.productId,
        subscriptionPeriod: sub.subscriptionPeriod,
        groupLevel: sub.groupLevel,
        familySharable: sub.familySharable,
        reviewNote: sub.reviewNote,
        state: this.state(sub),
      },
      relationships: {
        versions: { data: sub.versions.map((id) => ({ type: 'subscriptionVersions', id })) },
        appStoreReviewScreenshot: {
          data: sub.screenshot ? { type: 'subscriptionAppStoreReviewScreenshots', id: sub.screenshot } : null,
        },
      },
    }
  }

  private versionResources(ids: string[], type: string) {
    return ids.map((id) => ({ type, id, attributes: { state: this.versions.get(id)!.state } }))
  }

  // ---- routes -----------------------------------------------------------------------------------

  handle(req: Req): Response | undefined {
    const p = req.path
    const body = req.body as { data: Json & { attributes?: Json; relationships?: Json }; included?: Json[] }
    const error = (status: number, code: string, detail: string) => this.asc.error(status, code, detail)
    const rel = (name: string): string =>
      ((body.data.relationships?.[name] as Json | undefined)?.data as Json | undefined)?.id as string
    let m: RegExpMatchArray | null

    if (req.method === 'GET' && (m = p.match(/^v1\/apps\/(\w+)\/subscriptionGroups$/))) {
      const { items, next } = this.asc.page([...this.groups.values()], req, p)
      const included = items.flatMap((g) => this.versionResources(g.versions, 'subscriptionGroupVersions'))
      return json({
        data: items.map((g) => ({
          type: 'subscriptionGroups',
          id: g.id,
          attributes: { referenceName: g.referenceName },
          relationships: {
            versions: { data: g.versions.map((id) => ({ type: 'subscriptionGroupVersions', id })) },
          },
        })),
        included,
        links: { next },
      })
    }
    if (req.method === 'POST' && p === 'v1/subscriptionGroups') {
      const name = body.data.attributes!.referenceName as string
      if (this.groupByName(name))
        return error(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE', 'group exists')
      const id = this.asc.nextId()
      this.groups.set(id, { id, referenceName: name, versions: [] })
      if (this.asc.autoDraftVersion)
        this.groups.get(id)!.versions.push(this.newVersion(id, 'PREPARE_FOR_SUBMISSION'))
      return json({ data: { type: 'subscriptionGroups', id, attributes: { referenceName: name } } }, 201)
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/subscriptionGroups\/(\w+)\/subscriptions$/))) {
      const { items, next } = this.asc.page(
        [...this.subs.values()].filter((s) => s.group === m![1]),
        req,
        p,
      )
      const included = items.flatMap((s) => [
        ...this.versionResources(s.versions, 'subscriptionVersions'),
        ...(s.screenshot ? [this.screenshotJson(s.screenshot)] : []),
      ])
      return json({ data: items.map((s) => this.subJson(s)), included, links: { next } })
    }

    // Versions and localizations of subscriptions and groups.
    for (const v of VERSIONED) {
      const owners = v.parent === 'subscriptions' ? this.subs : this.groups
      if (req.method === 'GET' && (m = p.match(new RegExp(`^v1/${v.parent}/(\\w+)/versions$`)))) {
        const owner = owners.get(m[1]!)
        if (!owner) return error(404, 'NOT_FOUND', 'no such parent')
        return json({ data: this.versionResources(owner.versions, v.versionType), links: {} })
      }
      if (req.method === 'POST' && p === `v1/${v.versionType}`) {
        const parentId = rel(v.parent === 'subscriptions' ? 'subscription' : 'subscriptionGroup')
        const owner = owners.get(parentId)
        if (!owner) return error(404, 'NOT_FOUND', 'no such parent')
        if (owner.versions.some((x) => this.versions.get(x)!.state === 'PREPARE_FOR_SUBMISSION')) {
          return error(409, 'STATE_ERROR', 'a draft version exists')
        }
        const id = this.newVersion(parentId, 'PREPARE_FOR_SUBMISSION')
        const latest = owner.versions.at(-1)
        for (const l of [...this.localizations.values()].filter((x) => x.version === latest)) {
          this.localizations.set(this.asc.nextId(), { ...l, version: id })
        }
        owner.versions.push(id)
        return json(
          { data: { type: v.versionType, id, attributes: { state: 'PREPARE_FOR_SUBMISSION' } } },
          201,
        )
      }
      if (req.method === 'GET' && (m = p.match(new RegExp(`^v1/${v.versionType}/(\\w+)/localizations$`)))) {
        const data = [...this.localizations.entries()]
          .filter(([, l]) => l.version === m![1])
          .map(([id, l]) => ({
            type: v.localizationType,
            id,
            attributes: { locale: l.locale, name: l.name, description: l.description },
          }))
        return json({ data, links: {} })
      }
      if (req.method === 'POST' && p === `v2/${v.localizationType}`) {
        const a = body.data.attributes!
        const version = rel('version')
        if (!this.versions.has(version)) return error(404, 'NOT_FOUND', 'no version')
        const id = this.asc.nextId()
        this.localizations.set(id, {
          version,
          locale: a.locale as string,
          name: a.name as string,
          description: (a.description as string) ?? null,
        })
        return json({ data: { type: v.localizationType, id } }, 201)
      }
      if (req.method === 'PATCH' && (m = p.match(new RegExp(`^v2/${v.localizationType}/(\\w+)$`)))) {
        const l = this.localizations.get(m[1]!)
        if (!l) return error(404, 'NOT_FOUND', 'no localization')
        const a = body.data.attributes!
        if ('locale' in a) return error(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', 'locale is not editable')
        Object.assign(l, a)
        return json({ data: { type: v.localizationType, id: m[1] } })
      }
    }

    if (req.method === 'POST' && p === 'v1/subscriptions') {
      const a = body.data.attributes!
      const group = rel('group')
      if (!this.groups.has(group)) return error(404, 'NOT_FOUND', 'no group')
      if (this.byProductId(a.productId as string)) {
        return error(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE', 'This product ID has already been used')
      }
      const id = this.asc.nextId()
      const sub: Sub = {
        id,
        group,
        name: a.name as string,
        productId: a.productId as string,
        subscriptionPeriod: (a.subscriptionPeriod as string) ?? 'ONE_MONTH',
        groupLevel: (a.groupLevel as number) ?? 1,
        familySharable: (a.familySharable as boolean) ?? false,
        reviewNote: (a.reviewNote as string) ?? null,
        versions: [],
      }
      this.subs.set(id, sub)
      if (this.asc.autoDraftVersion) sub.versions.push(this.newVersion(id, 'PREPARE_FOR_SUBMISSION'))
      return json({ data: this.subJson(sub) }, 201)
    }
    if (req.method === 'PATCH' && (m = p.match(/^v1\/subscriptions\/(\w+)$/))) {
      const sub = this.subs.get(m[1]!)
      if (!sub) return error(404, 'NOT_FOUND', 'no subscription')
      const a = body.data.attributes ?? {}
      for (const k of Object.keys(a)) {
        if (!['name', 'reviewNote', 'familySharable', 'groupLevel'].includes(k)) {
          return error(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', `${k} is not editable`)
        }
      }
      if (sub.familySharable && a.familySharable === false) {
        return error(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', 'Family Sharing cannot be turned off')
      }
      const refs = (body.data.relationships?.prices as Json | undefined)?.data as Json[] | undefined
      if (refs) {
        if (!this.bulkPricePatch)
          return error(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', 'prices are not patchable')
        const ids = refs.map((r) => r.id)
        const writes: { point: string; startDate: string | null; preserved: boolean }[] = []
        for (const inc of body.included ?? []) {
          if (!ids.includes(inc.id)) return error(409, 'ENTITY_ERROR.INCLUDED', 'not referenced')
          const attrs = (inc.attributes ?? {}) as Json
          writes.push({
            point: (((inc.relationships as Json).subscriptionPricePoint as Json).data as Json).id as string,
            startDate: (attrs.startDate as string) ?? null,
            preserved: attrs.preserveCurrentPrice === true,
          })
        }
        const failure = this.checkPrices(
          sub,
          writes.map((w) => w.point),
        )
        if (failure) return failure
        for (const w of writes) this.writePrice(sub, w.point, w.startDate, w.preserved)
      }
      Object.assign(sub, a)
      return json({ data: this.subJson(sub) })
    }

    if (req.method === 'POST' && p === 'v1/subscriptionPlanAvailabilities') {
      if (!this.planAvailability)
        return error(404, 'NOT_FOUND', 'subscriptionPlanAvailabilities is not available')
      return this.setAvailability(rel('subscription'), body, 'plan')
    }
    if (req.method === 'POST' && p === 'v1/subscriptionAvailabilities') {
      return this.setAvailability(rel('subscription'), body, 'legacy')
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/subscriptions\/(\w+)\/planAvailabilities$/))) {
      if (!this.planAvailability) return error(404, 'NOT_FOUND', 'planAvailabilities is not available')
      const sub = this.subs.get(m[1]!)
      return json({
        data: sub?.availability === 'plan' ? [{ type: 'subscriptionPlanAvailabilities', id: sub.id }] : [],
      })
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/subscriptions\/(\w+)\/subscriptionAvailability$/))) {
      const sub = this.subs.get(m[1]!)
      return json({
        data: sub?.availability === 'legacy' ? { type: 'subscriptionAvailabilities', id: sub.id } : null,
      })
    }

    if (req.method === 'GET' && (m = p.match(/^v1\/subscriptions\/(\w+)\/pricePoints$/))) {
      if (req.query.get('filter[territory]') !== 'USA') return error(400, 'PARAMETER_ERROR', 'territory')
      return json({
        data: USA_PRICES.map((price) => ({
          type: 'subscriptionPricePoints',
          id: `spp-${m![1]}-USA-${price}`,
          attributes: { customerPrice: price },
        })),
        links: {},
      })
    }
    if (
      req.method === 'GET' &&
      (m = p.match(/^v1\/subscriptionPricePoints\/spp-(\w+)-USA-([\d.]+)\/equalizations$/))
    ) {
      const others = this.asc.territories.filter((t) => t !== 'USA')
      const { items, next } = this.asc.page(others, req, p)
      return json({
        data: items.map((t) => ({
          type: 'subscriptionPricePoints',
          id: `spp-${m![1]}-${t}-${equalized(t, m![2]!)}`,
          attributes: { customerPrice: equalized(t, m![2]!) },
          relationships: { territory: { data: { type: 'territories', id: t } } },
        })),
        links: { next },
      })
    }
    if (req.method === 'POST' && p === 'v1/subscriptionPrices') {
      const sub = this.subs.get(rel('subscription'))
      if (!sub) return error(404, 'NOT_FOUND', 'no subscription')
      const point = rel('subscriptionPricePoint')
      const failure = this.checkPrices(sub, [point])
      if (failure) return failure
      const a = body.data.attributes ?? {}
      this.writePrice(sub, point, (a.startDate as string) ?? null, a.preserveCurrentPrice === true)
      return json({ data: { type: 'subscriptionPrices', id: `sp-${sub.id}-${point}` } }, 201)
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/subscriptions\/(\w+)\/prices$/))) {
      const territory = req.query.get('filter[territory]')
      const prices = (this.prices.get(m[1]!) ?? []).filter((x) => !territory || x.territory === territory)
      return json({
        data: prices.map((x) => ({
          type: 'subscriptionPrices',
          id: `sp-${m![1]}-${x.point}`,
          attributes: { startDate: x.startDate, preserved: x.preserved },
          relationships: {
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: x.point } },
          },
        })),
        included: prices.map((x) => ({
          type: 'subscriptionPricePoints',
          id: x.point,
          attributes: { customerPrice: x.customerPrice },
        })),
        links: {},
      })
    }

    if (req.method === 'GET' && (m = p.match(/^v1\/subscriptions\/(\w+)\/introductoryOffers$/))) {
      const data = [...this.offers.entries()]
        .filter(([, o]) => o.sub === m![1])
        .map(([id, o]) => ({
          type: 'subscriptionIntroductoryOffers',
          id,
          attributes: {
            duration: o.duration,
            offerMode: o.offerMode,
            numberOfPeriods: o.numberOfPeriods,
            endDate: o.endDate,
          },
        }))
      return json({ data, links: {} })
    }
    if (req.method === 'POST' && p === 'v1/subscriptionIntroductoryOffers') {
      const a = body.data.attributes!
      const sub = rel('subscription')
      const territory = rel('territory')
      if (!this.subs.has(sub)) return error(404, 'NOT_FOUND', 'no subscription')
      if ([...this.offers.values()].some((o) => o.sub === sub && o.territory === territory)) {
        return error(409, 'ENTITY_ERROR', 'an introductory offer exists in this territory')
      }
      if (!this.availabilities.get(sub)?.territories.includes(territory)) {
        return error(409, 'ENTITY_ERROR.UNSUPPORTED_TERRITORY', 'not available in this territory')
      }
      const id = this.asc.nextId()
      this.offers.set(id, {
        sub,
        territory,
        duration: a.duration as string,
        offerMode: a.offerMode as string,
        numberOfPeriods: a.numberOfPeriods as number,
        endDate: null,
      })
      return json({ data: { type: 'subscriptionIntroductoryOffers', id } }, 201)
    }

    if (req.method === 'POST' && p === 'v1/subscriptionAppStoreReviewScreenshots') {
      const subId = rel('subscription')
      const sub = this.subs.get(subId)
      if (!sub) return error(404, 'NOT_FOUND', 'no subscription')
      if (sub.screenshot) return error(409, 'STATE_ERROR', 'a screenshot exists')
      const id = this.asc.nextId()
      const a = body.data.attributes!
      this.asc.screenshots.set(id, {
        iap: subId,
        fileName: a.fileName as string,
        fileSize: a.fileSize as number,
        checksum: null,
        state: 'AWAITING_UPLOAD',
        bytes: 0,
      })
      sub.screenshot = id
      return json({ data: this.screenshotJson(id) }, 201)
    }
    if (req.method === 'PATCH' && (m = p.match(/^v1\/subscriptionAppStoreReviewScreenshots\/(\w+)$/))) {
      const s = this.asc.screenshots.get(m[1]!)
      if (!s) return error(404, 'NOT_FOUND', 'no screenshot')
      const a = body.data.attributes!
      if (a.uploaded) {
        s.checksum = a.sourceFileChecksum as string
        s.state = s.bytes === s.fileSize ? 'UPLOAD_COMPLETE' : 'FAILED'
      }
      return json({ data: this.screenshotJson(m[1]!) })
    }
    if (req.method === 'GET' && (m = p.match(/^v1\/subscriptionAppStoreReviewScreenshots\/(\w+)$/))) {
      const s = this.asc.screenshots.get(m[1]!)
      if (!s) return error(404, 'NOT_FOUND', 'no screenshot')
      if (s.state === 'UPLOAD_COMPLETE') s.state = 'COMPLETE'
      return json({ data: this.screenshotJson(m[1]!) })
    }
    return undefined
  }

  private screenshotJson(id: string) {
    return { ...this.asc.screenshotJson(id), type: 'subscriptionAppStoreReviewScreenshots' }
  }

  private setAvailability(subId: string, body: { data: Json; included?: Json[] }, kind: 'plan' | 'legacy') {
    const sub = this.subs.get(subId)
    if (!sub) return this.asc.error(404, 'NOT_FOUND', 'no subscription')
    const rels = body.data.relationships as Json
    sub.availability = kind
    this.availabilities.set(subId, {
      territories: ((rels.availableTerritories as Json).data as Json[]).map((t) => t.id as string),
      availableInNewTerritories: (body.data.attributes as Json).availableInNewTerritories as boolean,
    })
    return json({ data: { type: 'subscriptionAvailabilities', id: subId } }, 201)
  }

  /** Price points must belong to the subscription and name a territory it is available in. */
  private checkPrices(sub: Sub, points: string[]): Response | undefined {
    for (const point of points) {
      const m = point.match(/^spp-(\w+)-([A-Z]{3})-([\d.]+)$/)
      if (!m || m[1] !== sub.id) return this.asc.error(404, 'ENTITY_ERROR.NOT_FOUND', 'unknown price point')
      if (!this.availabilities.get(sub.id)?.territories.includes(m[2]!)) {
        return this.asc.error(409, 'ENTITY_ERROR.UNSUPPORTED_TERRITORY', `not available in ${m[2]}`)
      }
    }
    return undefined
  }

  /** A price effective now supersedes the territory's current one. */
  private writePrice(sub: Sub, point: string, startDate: string | null, preserved: boolean): void {
    const m = point.match(/^spp-\w+-([A-Z]{3})-([\d.]+)$/)!
    const list = this.prices.get(sub.id) ?? []
    const keep = list.filter((x) => x.territory !== m[1] || x.startDate !== startDate)
    keep.push({ territory: m[1]!, point, customerPrice: m[2]!, startDate, preserved })
    this.prices.set(sub.id, keep)
  }
}
