import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import { type Client, StoreError } from './http'
import { type AppleDesired, samePrice } from './model'
import { type Action, type Diff, ERROR_KIND, errorAction, type StatusRow, type StoreAdapter } from './types'

/**
 * App Store Connect, one-time in-app purchases (plan-4 §5 Apple). Localizations live on an IAP
 * **version** (API 4.4.1+): kit edits the PREPARE_FOR_SUBMISSION version and creates one when
 * there is none. Prices are a schedule kit always sends whole (current + dated changes).
 * Never deletes anything: a review screenshot that differs is reported for a manual replace.
 */

// ---- response shapes ------------------------------------------------------------------------------

const ref = z.object({ type: z.string(), id: z.string() })
const toOne = z.object({ data: ref.nullable().optional() }).optional()
const toMany = z.object({ data: z.array(ref).optional() }).optional()
const links = z.object({ next: z.string().nullish() }).optional()
const resource = z.object({
  type: z.string(),
  id: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
})

const appsResponse = z.object({
  data: z.array(z.object({ id: z.string(), attributes: z.object({ bundleId: z.string() }) })),
})

const iapResource = z.object({
  id: z.string(),
  attributes: z.object({
    name: z.string(),
    productId: z.string(),
    inAppPurchaseType: z.string(),
    state: z.string().nullish(),
    reviewNote: z.string().nullish(),
    familySharable: z.boolean().nullish(),
  }),
  relationships: z
    .object({
      versions: toMany,
      inAppPurchaseAvailability: toOne,
      appStoreReviewScreenshot: toOne,
      iapPriceSchedule: toOne,
    })
    .optional(),
})
const iapList = z.object({ data: z.array(iapResource), included: z.array(resource).optional(), links })

const versionsResponse = z.object({
  data: z.array(z.object({ id: z.string(), attributes: z.object({ state: z.string().nullish() }) })),
  links,
})
const localizationsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({
        locale: z.string(),
        name: z.string().nullish(),
        description: z.string().nullish(),
      }),
    }),
  ),
  links,
})
const manualPricesResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({ startDate: z.string().nullish(), endDate: z.string().nullish() }).optional(),
      relationships: z.object({ inAppPurchasePricePoint: toOne }).optional(),
    }),
  ),
  included: z.array(resource).optional(),
  links,
})
const pricePointsResponse = z.object({
  data: z.array(z.object({ id: z.string(), attributes: z.object({ customerPrice: z.string() }) })),
  links,
})
const territoriesResponse = z.object({ data: z.array(z.object({ id: z.string() })), links })
const created = z.object({ data: z.object({ id: z.string() }) })
const anyJson = z.unknown()
const screenshotResponse = z.object({
  data: z.object({
    id: z.string(),
    attributes: z
      .object({
        uploadOperations: z
          .array(
            z.object({
              method: z.string(),
              url: z.string(),
              offset: z.number(),
              length: z.number(),
              requestHeaders: z.array(z.object({ name: z.string(), value: z.string() })).nullish(),
            }),
          )
          .nullish(),
        assetDeliveryState: z
          .object({
            state: z.string(),
            errors: z.array(z.object({ description: z.string().nullish() })).nullish(),
          })
          .nullish(),
      })
      .optional(),
  }),
})

// ---- observed -------------------------------------------------------------------------------------

export interface AppleIap {
  ascId: string
  productId: string
  type: string
  referenceName: string
  reviewNote?: string
  familySharable: boolean
  state?: string
  /** The version kit reads localizations from: the draft, else the latest. */
  version?: { id: string; state?: string }
  hasDraft: boolean
  localizations: { id: string; locale: string; name: string; description: string }[]
  scheduleId?: string
  /** USA manual prices. */
  prices: { startDate: string | null; endDate: string | null; customerPrice: string; preserved?: boolean }[]
  availability: boolean
  screenshot?: { id: string; checksum?: string; fileName?: string; fileSize?: number; state?: string }
}

export interface AppleObserved {
  appId: string
  bundleId: string
  today: string
  iaps: AppleIap[]
}

const TYPE_WORD: Record<string, string> = {
  NON_CONSUMABLE: 'non-consumable',
  CONSUMABLE: 'consumable',
  NON_RENEWING_SUBSCRIPTION: 'non-renewing subscription',
}

const DRAFT = 'PREPARE_FOR_SUBMISSION'

/** Price in effect `today` and the dated ones after it, from the USA manual prices. */
export function observedPrices(
  prices: AppleIap['prices'],
  today: string,
): { current?: string; inEffect: string[]; scheduled: { from: string; price: string }[] } {
  let current: { start: string; price: string } | undefined
  const scheduled: { from: string; price: string }[] = []
  let tied: string[] = []
  for (const p of prices) {
    if (p.endDate && p.endDate <= today) continue
    const start = p.startDate ?? ''
    if (p.startDate && p.startDate > today) scheduled.push({ from: p.startDate, price: p.customerPrice })
    else if (!current || start > current.start) {
      current = { start, price: p.customerPrice }
      tied = [p.customerPrice]
    } else if (start === current.start) {
      tied.push(p.customerPrice)
      // Ties (an old price kept for subscribers next to the new one, both in effect): prefer the
      // one not marked preserved; which of the two Apple marks is unverified, so `inEffect` keeps both.
      if (!p.preserved) current = { start, price: p.customerPrice }
    }
  }
  scheduled.sort((a, b) => a.from.localeCompare(b.from))
  return { current: current?.price, inEffect: tied, scheduled }
}

// ---- actions --------------------------------------------------------------------------------------

export type AppleAction =
  | Action<{ message: string }>
  | Action<{ attributes: Record<string, unknown> }>
  | Action<{ locales: Record<string, { name: string; description: string }> }>
  | Action<{ price: string; scheduled: { from: string; price: string }[]; points?: Record<string, string> }>
  | Action<{ screenshot: NonNullable<AppleDesired['screenshot']> }>
  | Action

const priceText = (price: string, scheduled: { from: string; price: string }[]) =>
  `${price}${scheduled.map((s) => ` (${s.price} from ${s.from})`).join('')}`

/**
 * Why an observed review screenshot is not the file's, or undefined when it is. Only a COMPLETE
 * upload counts: one reserved but never uploaded (AWAITING_UPLOAD) has no checksum and would
 * otherwise pass on name and size alone. kit never deletes, so every case is a note.
 */
export function screenshotProblem(
  s: { checksum?: string | null; fileSize?: number | null; fileName?: string | null; state?: string | null },
  want: { md5: string; size: number; fileName: string },
): string | undefined {
  if (s.state === 'FAILED')
    return 'the review screenshot upload FAILED: delete it in App Store Connect, then sync again'
  if (s.state === 'AWAITING_UPLOAD' || (s.state && s.state !== 'COMPLETE' && s.state !== 'UPLOAD_COMPLETE')) {
    return `the review screenshot is ${s.state}: its upload never finished; delete it in App Store Connect, then sync again`
  }
  if (s.state === 'UPLOAD_COMPLETE')
    return 'the review screenshot is still processing: check status again shortly'
  const same = s.checksum
    ? s.checksum.toLowerCase() === want.md5
    : s.fileSize === want.size && s.fileName === want.fileName
  return same
    ? undefined
    : 'the review screenshot differs: kit never deletes, so replace it in App Store Connect (or delete it there and sync again)'
}
export function diffApple(
  desired: AppleDesired[],
  observed: AppleObserved,
  opts: { extras: boolean } = { extras: true },
): Diff<AppleAction> {
  const rows: StatusRow[] = []
  const actions: AppleAction[] = []
  const byId = new Map(observed.iaps.map((i) => [i.productId, i]))
  const approved = new Set(observed.iaps.filter((i) => i.state === 'APPROVED').map((i) => i.type))
  const act = (id: string, kind: string, summary: string, payload?: unknown) =>
    actions.push({ store: 'apple', id, kind, summary, payload })

  for (const d of desired) {
    const o = byId.get(d.productId)
    const notes: string[] = []
    if (!approved.has(d.type)) {
      notes.push(
        `the first ${TYPE_WORD[d.type]} ships with the app's next version: submit it from App Store Connect`,
      )
    }
    for (const s of d.scheduled) notes.push(`scheduled ${s.price} from ${s.from}`)
    if (!d.screenshot) notes.push('no review screenshot: App Store Connect keeps it MISSING_METADATA')

    if (!o) {
      act(d.productId, 'create', 'create', { attributes: createAttributes(d) })
      act(d.productId, 'localizations', `localization ${Object.keys(d.localizations).join(', ')}`, {
        locales: d.localizations,
      })
      act(d.productId, 'price', `price ${priceText(d.price, d.scheduled)}`, {
        price: d.price,
        scheduled: d.scheduled,
      })
      act(d.productId, 'availability', 'availability')
      if (d.screenshot) act(d.productId, 'screenshot', 'screenshot', { screenshot: d.screenshot })
      rows.push({ store: 'apple', id: d.productId, sync: 'missing', notes })
      continue
    }

    const fields: string[] = []
    if (o.type !== d.type) {
      fields.push('type')
      actions.push(
        errorAction('apple', d.productId, `type is ${o.type}; it cannot change: use a new product id`),
      )
    }
    if (d.type === 'NON_CONSUMABLE' && o.familySharable && !d.familySharable) {
      fields.push('familySharable')
      actions.push(
        errorAction(
          'apple',
          d.productId,
          'Family Sharing is on and Apple cannot turn it off; set familySharable: true',
        ),
      )
    }
    const patch: Record<string, unknown> = {}
    if (o.referenceName !== d.referenceName) patch.name = d.referenceName
    if (d.reviewNote !== undefined && (o.reviewNote ?? '') !== d.reviewNote) patch.reviewNote = d.reviewNote
    if (d.type === 'NON_CONSUMABLE' && d.familySharable && !o.familySharable) patch.familySharable = true
    if (Object.keys(patch).length) {
      const names = Object.keys(patch).map((k) => (k === 'name' ? 'referenceName' : k))
      fields.push(...names)
      act(d.productId, 'update', `update ${names.join(', ')}`, { attributes: patch })
    }

    const changedLocales: Record<string, { name: string; description: string }> = {}
    for (const [locale, l] of Object.entries(d.localizations)) {
      const have = o.localizations.find((x) => x.locale === locale)
      if (!have || have.name !== l.name || have.description !== l.description) changedLocales[locale] = l
    }
    if (Object.keys(changedLocales).length) {
      fields.push(...Object.keys(changedLocales).map((l) => `localization ${l}`))
      const newVersion = o.hasDraft ? '' : ' (new version)'
      act(
        d.productId,
        'localizations',
        `localization ${Object.keys(changedLocales).join(', ')}${newVersion}`,
        {
          locales: changedLocales,
        },
      )
    }
    for (const extra of o.localizations.filter((x) => !(x.locale in d.localizations))) {
      notes.push(`localization ${extra.locale} is not in the file (kept)`)
    }

    const have = observedPrices(o.prices, observed.today)
    const samePlan =
      have.current !== undefined &&
      samePrice(have.current, d.price) &&
      have.scheduled.length === d.scheduled.length &&
      have.scheduled.every(
        (s, i) => s.from === d.scheduled[i]!.from && samePrice(s.price, d.scheduled[i]!.price),
      )
    if (!samePlan) {
      fields.push('price')
      act(d.productId, 'price', `price ${priceText(d.price, d.scheduled)}`, {
        price: d.price,
        scheduled: d.scheduled,
      })
    }

    if (!o.availability) {
      fields.push('availability')
      act(d.productId, 'availability', 'availability')
    }

    if (d.screenshot) {
      const s = o.screenshot
      if (!s) {
        fields.push('screenshot')
        act(d.productId, 'screenshot', 'screenshot', { screenshot: d.screenshot })
      } else {
        const problem = screenshotProblem(s, d.screenshot)
        if (problem) {
          fields.push('screenshot')
          notes.push(problem)
        }
      }
    }

    rows.push({
      store: 'apple',
      id: d.productId,
      sync: fields.length ? 'differs' : 'in-sync',
      ...(fields.length ? { fields } : {}),
      storeState: [o.state, o.version?.state ? `version ${o.version.state}` : undefined]
        .filter(Boolean)
        .join(' · '),
      notes,
    })
  }

  if (opts.extras) {
    const wanted = new Set(desired.map((d) => d.productId))
    for (const o of observed.iaps) {
      if (!wanted.has(o.productId)) {
        rows.push({
          store: 'apple',
          id: o.productId,
          sync: 'extra',
          storeState: o.state,
          notes: ['not in the file (left alone)'],
        })
      }
    }
  }
  return { rows, actions }
}

function createAttributes(d: AppleDesired): Record<string, unknown> {
  return {
    name: d.referenceName,
    productId: d.productId,
    inAppPurchaseType: d.type,
    ...(d.reviewNote !== undefined ? { reviewNote: d.reviewNote } : {}),
    // Family Sharing exists for non-consumables only.
    ...(d.type === 'NON_CONSUMABLE' ? { familySharable: d.familySharable } : {}),
  }
}

// ---- adapter --------------------------------------------------------------------------------------

export interface AppleAdapterOptions {
  bundleId: string
  today: string
  sleep?: (ms: number) => Promise<void>
  /** Screenshot processing: poll every `pollMs` up to `pollLimitMs`. */
  pollMs?: number
  pollLimitMs?: number
}

export function appleAdapter(
  client: Client,
  opts: AppleAdapterOptions,
): StoreAdapter<AppleDesired, AppleObserved, AppleAction> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms))
  let observed: AppleObserved | undefined
  const ascIds = new Map<string, string>()
  const pointCache = new Map<string, Map<string, string>>()
  let territories: string[] | undefined

  async function pages<T extends { links?: { next?: string | null } }>(
    path: string,
    query: Record<string, string | number> | undefined,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const out: T[] = []
    let next: string | undefined = path
    let q: typeof query = query
    while (next) {
      const page: T = await client.request('GET', next, { query: q, schema })
      out.push(page)
      next = page.links?.next ?? undefined
      q = undefined
    }
    return out
  }

  const ascId = (productId: string): string => {
    const id = ascIds.get(productId)
    if (!id) throw new Error(`${productId} does not exist in App Store Connect yet`)
    return id
  }

  /** USA price points of one IAP, customerPrice → point id. */
  async function pricePoints(id: string): Promise<Map<string, string>> {
    const cached = pointCache.get(id)
    if (cached) return cached
    const points = new Map<string, string>()
    for (const page of await pages(
      `v2/inAppPurchases/${id}/pricePoints`,
      { 'filter[territory]': 'USA', limit: 8000 },
      pricePointsResponse,
    )) {
      for (const p of page.data) points.set(p.attributes.customerPrice, p.id)
    }
    pointCache.set(id, points)
    return points
  }

  const findPoint = (points: Map<string, string>, price: string): string | undefined => {
    for (const [customer, id] of points) if (samePrice(customer, price)) return id
    return undefined
  }

  async function allTerritories(): Promise<string[]> {
    if (territories) return territories
    const ids: string[] = []
    for (const page of await pages('v1/territories', { limit: 200 }, territoriesResponse)) {
      ids.push(...page.data.map((t) => t.id))
    }
    territories = ids
    return ids
  }

  async function draftVersion(id: string): Promise<string> {
    const versions = (
      await pages(`v2/inAppPurchases/${id}/versions`, { limit: 50 }, versionsResponse)
    ).flatMap((p) => p.data)
    const draft = versions.find((v) => v.attributes.state === DRAFT)
    if (draft) return draft.id
    const res = await client.request('POST', 'v1/inAppPurchaseVersions', {
      body: {
        data: {
          type: 'inAppPurchaseVersions',
          relationships: { inAppPurchase: { data: { type: 'inAppPurchases', id } } },
        },
      },
      schema: created,
    })
    return res.data.id
  }

  async function uploadScreenshot(id: string, shot: NonNullable<AppleDesired['screenshot']>): Promise<void> {
    const reserved = await client.request('POST', 'v1/inAppPurchaseAppStoreReviewScreenshots', {
      body: {
        data: {
          type: 'inAppPurchaseAppStoreReviewScreenshots',
          attributes: { fileName: shot.fileName, fileSize: shot.size },
          relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id } } },
        },
      },
      schema: screenshotResponse,
    })
    const sid = reserved.data.id
    const bytes = readFileSync(shot.path)
    for (const op of reserved.data.attributes?.uploadOperations ?? []) {
      // Upload URLs are pre-signed: no App Store Connect token.
      const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]))
      const res = await fetch(op.url, {
        method: op.method,
        headers,
        body: bytes.subarray(op.offset, op.offset + op.length),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok)
        throw new StoreError(
          'apple',
          res.status,
          undefined,
          `screenshot upload: ${(await res.text()).slice(0, 200)}`,
        )
    }
    await client.request('PATCH', `v1/inAppPurchaseAppStoreReviewScreenshots/${sid}`, {
      body: {
        data: {
          type: 'inAppPurchaseAppStoreReviewScreenshots',
          id: sid,
          attributes: { uploaded: true, sourceFileChecksum: shot.md5 },
        },
      },
      schema: anyJson,
    })
    const limit = opts.pollLimitMs ?? 60_000
    const every = opts.pollMs ?? 2000
    for (let waited = 0; ; waited += every) {
      const s = await client.request('GET', `v1/inAppPurchaseAppStoreReviewScreenshots/${sid}`, {
        schema: screenshotResponse,
      })
      const state = s.data.attributes?.assetDeliveryState?.state
      if (state === 'COMPLETE') return
      if (state === 'FAILED') {
        const why = s.data.attributes?.assetDeliveryState?.errors?.map((e) => e.description).join('; ')
        throw new Error(`App Store Connect could not process the review screenshot${why ? `: ${why}` : ''}`)
      }
      if (waited >= limit) {
        throw new Error(
          `the review screenshot is still ${state ?? 'processing'} after ${limit / 1000} s; run status later`,
        )
      }
      await sleep(every)
    }
  }

  return {
    store: 'apple',
    label: `App Store Connect (${opts.bundleId})`,

    async observe(desired) {
      const apps = await client.request('GET', 'v1/apps', {
        query: { 'filter[bundleId]': opts.bundleId, limit: 200 },
        schema: appsResponse,
      })
      const app = apps.data.find((a) => a.attributes.bundleId === opts.bundleId)
      if (!app) {
        throw new KitError(
          `No app with bundle id ${opts.bundleId} in App Store Connect`,
          'Create the app in App Store Connect, or fix iap.apple.bundleId',
          ExitCode.precondition,
        )
      }
      const wanted = new Set(desired.map((d) => d.productId))
      const iaps: AppleIap[] = []
      for (const page of await pages(
        `v1/apps/${app.id}/inAppPurchasesV2`,
        {
          limit: 200,
          include: 'iapPriceSchedule,inAppPurchaseAvailability,appStoreReviewScreenshot,versions',
          'limit[versions]': 50,
        },
        iapList,
      )) {
        const included = new Map((page.included ?? []).map((r) => [`${r.type}/${r.id}`, r.attributes ?? {}]))
        for (const r of page.data) {
          const a = r.attributes
          const versions = (r.relationships?.versions?.data ?? []).map((v) => ({
            id: v.id,
            state: included.get(`${v.type}/${v.id}`)?.state as string | undefined,
          }))
          const draft = versions.find((v) => v.state === DRAFT)
          const live = versions.filter((v) => v.state !== 'REPLACED_WITH_NEW_VERSION')
          const shotRef = r.relationships?.appStoreReviewScreenshot?.data
          const shot = shotRef ? included.get(`${shotRef.type}/${shotRef.id}`) : undefined
          iaps.push({
            ascId: r.id,
            productId: a.productId,
            type: a.inAppPurchaseType,
            referenceName: a.name,
            reviewNote: a.reviewNote ?? undefined,
            familySharable: a.familySharable ?? false,
            state: a.state ?? undefined,
            version: draft ?? live.at(-1) ?? versions.at(-1),
            hasDraft: !!draft,
            localizations: [],
            scheduleId: r.relationships?.iapPriceSchedule?.data?.id,
            prices: [],
            availability: !!r.relationships?.inAppPurchaseAvailability?.data,
            screenshot: shotRef
              ? {
                  id: shotRef.id,
                  checksum: (shot?.sourceFileChecksum as string | null | undefined) ?? undefined,
                  fileName: (shot?.fileName as string | undefined) ?? undefined,
                  fileSize: (shot?.fileSize as number | undefined) ?? undefined,
                  state: (shot?.assetDeliveryState as { state?: string } | undefined)?.state,
                }
              : undefined,
          })
        }
      }
      for (const iap of iaps) {
        ascIds.set(iap.productId, iap.ascId)
        if (!wanted.has(iap.productId)) continue
        if (iap.version) {
          for (const page of await pages(
            `v1/inAppPurchaseVersions/${iap.version.id}/localizations`,
            { limit: 200 },
            localizationsResponse,
          )) {
            iap.localizations.push(
              ...page.data.map((l) => ({
                id: l.id,
                locale: l.attributes.locale,
                name: l.attributes.name ?? '',
                description: l.attributes.description ?? '',
              })),
            )
          }
        }
        if (iap.scheduleId) {
          for (const page of await pages(
            `v1/inAppPurchasePriceSchedules/${iap.scheduleId}/manualPrices`,
            { 'filter[territory]': 'USA', include: 'inAppPurchasePricePoint', limit: 200 },
            manualPricesResponse,
          )) {
            const points = new Map(
              (page.included ?? []).map((r) => [`${r.type}/${r.id}`, r.attributes ?? {}]),
            )
            for (const p of page.data) {
              const pt = p.relationships?.inAppPurchasePricePoint?.data
              const price = pt
                ? (points.get(`${pt.type}/${pt.id}`)?.customerPrice as string | undefined)
                : undefined
              if (price === undefined) continue
              iap.prices.push({
                startDate: p.attributes?.startDate ?? null,
                endDate: p.attributes?.endDate ?? null,
                customerPrice: price,
              })
            }
          }
        }
      }
      observed = { appId: app.id, bundleId: opts.bundleId, today: opts.today, iaps }
      return observed
    },

    diff: (desired, o, diffOpts) => diffApple(desired, o, diffOpts),

    async prepare(actions, o) {
      // A price must be one of Apple's points. Existing IAPs list their own; a new one is checked
      // against the app's USA points as a stand-in, and resolved again after it is created.
      let appPoints: Map<string, string> | undefined
      const failed = new Map<string, string>()
      for (const a of actions) {
        if (a.kind !== 'price') continue
        const p = a.payload as { price: string; scheduled: { from: string; price: string }[] }
        const existing = ascIds.get(a.id)
        let points: Map<string, string>
        if (existing) points = await pricePoints(existing)
        else {
          if (!appPoints) {
            appPoints = new Map()
            for (const page of await pages(
              `v1/apps/${o.appId}/appPricePoints`,
              { 'filter[territory]': 'USA', limit: 200 },
              pricePointsResponse,
            )) {
              for (const pt of page.data) appPoints.set(pt.attributes.customerPrice, pt.id)
            }
          }
          points = appPoints
        }
        const missing = [p.price, ...p.scheduled.map((s) => s.price)].filter((v) => !findPoint(points, v))
        if (missing.length)
          failed.set(a.id, `${missing.join(', ')} is not an App Store price point in the USA`)
      }
      if (!failed.size) return actions
      const out: AppleAction[] = []
      for (const a of actions) {
        const why = failed.get(a.id)
        if (!why) out.push(a)
        else if (!out.some((x) => x.id === a.id && x.kind === ERROR_KIND))
          out.push(errorAction('apple', a.id, why))
      }
      return out
    },

    async apply(action) {
      const p = action.payload as Record<string, unknown> | undefined
      switch (action.kind) {
        case ERROR_KIND:
          throw new Error((p as { message: string }).message)
        case 'create': {
          const res = await client.request('POST', 'v2/inAppPurchases', {
            body: {
              data: {
                type: 'inAppPurchases',
                attributes: (p as { attributes: Record<string, unknown> }).attributes,
                relationships: { app: { data: { type: 'apps', id: observed!.appId } } },
              },
            },
            schema: created,
          })
          ascIds.set(action.id, res.data.id)
          return
        }
        case 'update': {
          const id = ascId(action.id)
          await client.request('PATCH', `v2/inAppPurchases/${id}`, {
            body: {
              data: {
                type: 'inAppPurchases',
                id,
                attributes: (p as { attributes: Record<string, unknown> }).attributes,
              },
            },
            schema: anyJson,
          })
          return
        }
        case 'localizations': {
          const id = ascId(action.id)
          const version = await draftVersion(id)
          const have = (
            await pages(
              `v1/inAppPurchaseVersions/${version}/localizations`,
              { limit: 200 },
              localizationsResponse,
            )
          ).flatMap((x) => x.data)
          for (const [locale, l] of Object.entries(
            (p as { locales: Record<string, { name: string; description: string }> }).locales,
          )) {
            const existing = have.find((x) => x.attributes.locale === locale)
            if (!existing) {
              await client.request('POST', 'v2/inAppPurchaseLocalizations', {
                body: {
                  data: {
                    type: 'inAppPurchaseLocalizations',
                    attributes: { locale, name: l.name, description: l.description },
                    relationships: { version: { data: { type: 'inAppPurchaseVersions', id: version } } },
                  },
                },
                schema: created,
              })
            } else if (
              existing.attributes.name !== l.name ||
              existing.attributes.description !== l.description
            ) {
              await client.request('PATCH', `v2/inAppPurchaseLocalizations/${existing.id}`, {
                body: {
                  data: {
                    type: 'inAppPurchaseLocalizations',
                    id: existing.id,
                    attributes: { name: l.name, description: l.description },
                  },
                },
                schema: anyJson,
              })
            }
          }
          return
        }
        case 'price': {
          const id = ascId(action.id)
          const { price, scheduled } = p as { price: string; scheduled: { from: string; price: string }[] }
          const points = await pricePoints(id)
          const entries = [
            { startDate: null as string | null, price },
            ...scheduled.map((s) => ({ startDate: s.from as string | null, price: s.price })),
          ]
          const included = entries.map((e, i) => {
            const point = findPoint(points, e.price)
            if (!point) throw new Error(`${e.price} is not an App Store price point in the USA`)
            return {
              type: 'inAppPurchasePrices',
              id: `\${price-${i}}`,
              attributes: { startDate: e.startDate },
              relationships: {
                inAppPurchaseV2: { data: { type: 'inAppPurchases', id } },
                inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: point } },
              },
            }
          })
          await client.request('POST', 'v1/inAppPurchasePriceSchedules', {
            body: {
              data: {
                type: 'inAppPurchasePriceSchedules',
                relationships: {
                  inAppPurchase: { data: { type: 'inAppPurchases', id } },
                  baseTerritory: { data: { type: 'territories', id: 'USA' } },
                  manualPrices: { data: included.map((x) => ({ type: x.type, id: x.id })) },
                },
              },
              included,
            },
            schema: anyJson,
          })
          return
        }
        case 'availability': {
          const id = ascId(action.id)
          const all = await allTerritories()
          await client.request('POST', 'v1/inAppPurchaseAvailabilities', {
            body: {
              data: {
                type: 'inAppPurchaseAvailabilities',
                attributes: { availableInNewTerritories: true },
                relationships: {
                  inAppPurchase: { data: { type: 'inAppPurchases', id } },
                  availableTerritories: { data: all.map((t) => ({ type: 'territories', id: t })) },
                },
              },
            },
            schema: anyJson,
          })
          return
        }
        case 'screenshot':
          await uploadScreenshot(
            ascId(action.id),
            (p as { screenshot: NonNullable<AppleDesired['screenshot']> }).screenshot,
          )
          return
        default:
          throw new Error(`unknown Apple action ${action.kind}`)
      }
    },
  }
}
