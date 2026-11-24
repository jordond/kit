import type { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import type { AppleSubGroup, AppleSubPlan, AppleSubscriptionsObserved } from './apple-subscriptions-diff'
import {
  appsResponse,
  groupList,
  legacyAvailability,
  localizationsResponse,
  offersResponse,
  planAvailabilities,
  pricesResponse,
  subList,
} from './apple-subscriptions-schemas'
import { type Client, StoreError } from './http'

/** Read-only half of the App Store Connect subscriptions adapter. */

export const DRAFT = 'PREPARE_FOR_SUBMISSION'

/** A 4xx the store used to refuse a shape: the caller tries its fallback. */
export const refused = (e: unknown): e is StoreError =>
  e instanceof StoreError && e.status >= 400 && e.status < 500

export type Pager = <T extends { links?: { next?: string | null } }>(
  path: string,
  query: Record<string, string | number> | undefined,
  schema: z.ZodType<T>,
) => Promise<T[]>

/** GET every page of a list, following `links.next`. */
export const createPager =
  (client: Client): Pager =>
  async (path, query, schema) => {
    const out: z.infer<typeof schema>[] = []
    let next: string | undefined = path
    let q = query
    while (next) {
      const page: z.infer<typeof schema> = await client.request('GET', next, { query: q, schema })
      out.push(page)
      next = page.links?.next ?? undefined
      q = undefined
    }
    return out
  }

const versionOf = (
  rel: { data?: { type: string; id: string }[] } | undefined,
  included: Map<string, Record<string, unknown>>,
) => {
  const versions = (rel?.data ?? []).map((v) => ({
    id: v.id,
    state: included.get(`${v.type}/${v.id}`)?.state as string | undefined,
  }))
  const draft = versions.find((v) => v.state === DRAFT)
  const live = versions.filter((v) => v.state !== 'REPLACED_WITH_NEW_VERSION')
  return { version: draft ?? live.at(-1) ?? versions.at(-1), hasDraft: !!draft }
}

export interface ObserveContext {
  bundleId: string
  today: string
  /** File subscription ids: only these groups are read in detail. */
  wanted: Set<string>
  /** Filled while reading: file subscription id → group id, product id → subscription id. */
  groupIds: Map<string, string>
  subIds: Map<string, string>
  /** Every territory id (cached by the adapter); read only when a plan already has a trial. */
  territories: () => Promise<string[]>
}

export async function observeSubscriptions(
  client: Client,
  pages: Pager,
  ctx: ObserveContext,
): Promise<AppleSubscriptionsObserved> {
  const { today } = ctx

  /** Plan or deprecated availability; either present means available. */
  async function hasAvailability(id: string): Promise<boolean> {
    try {
      const r = await client.request('GET', `v1/subscriptions/${id}/planAvailabilities`, {
        schema: planAvailabilities,
      })
      if (r.data.length) return true
    } catch (e) {
      if (!refused(e)) throw e
    }
    try {
      const r = await client.request('GET', `v1/subscriptions/${id}/subscriptionAvailability`, {
        schema: legacyAvailability,
      })
      return !!r.data
    } catch (e) {
      if (!refused(e)) throw e
      return false
    }
  }

  async function planDetails(plan: AppleSubPlan): Promise<void> {
    if (plan.version) {
      for (const page of await pages(
        `v1/subscriptionVersions/${plan.version.id}/localizations`,
        { limit: 200 },
        localizationsResponse,
      )) {
        plan.localizations.push(
          ...page.data.map((l) => ({
            id: l.id,
            locale: l.attributes.locale,
            name: l.attributes.name ?? '',
            description: l.attributes.description ?? '',
          })),
        )
      }
    }
    for (const page of await pages(
      `v1/subscriptions/${plan.ascId}/prices`,
      { 'filter[territory]': 'USA', include: 'subscriptionPricePoint', limit: 200 },
      pricesResponse,
    )) {
      const points = new Map((page.included ?? []).map((r) => [`${r.type}/${r.id}`, r.attributes ?? {}]))
      for (const p of page.data) {
        plan.priceRows = (plan.priceRows ?? 0) + 1
        const pt = p.relationships?.subscriptionPricePoint?.data
        const price = pt
          ? (points.get(`${pt.type}/${pt.id}`)?.customerPrice as string | undefined)
          : undefined
        if (price === undefined) continue
        plan.prices.push({
          startDate: p.attributes?.startDate ?? null,
          endDate: p.attributes?.endDate ?? null,
          customerPrice: price,
          preserved: p.attributes?.preserved ?? false,
        })
      }
    }
    plan.availability = await hasAvailability(plan.ascId)
    for (const page of await pages(
      `v1/subscriptions/${plan.ascId}/introductoryOffers`,
      { limit: 200, include: 'territory' },
      offersResponse,
    )) {
      for (const o of page.data) {
        // An offer that ended before today no longer counts.
        if (o.attributes.endDate && o.attributes.endDate < today) continue
        plan.offers.push({
          id: o.id,
          mode: o.attributes.offerMode,
          duration: o.attributes.duration,
          territory: o.relationships?.territory?.data?.id,
          ...(o.attributes.endDate ? { endDate: o.attributes.endDate } : {}),
        })
      }
    }
  }

  const apps = await client.request('GET', 'v1/apps', {
    query: { 'filter[bundleId]': ctx.bundleId, limit: 200 },
    schema: appsResponse,
  })
  const app = apps.data.find((a) => a.attributes.bundleId === ctx.bundleId)
  if (!app) {
    throw new KitError(
      `No app with bundle id ${ctx.bundleId} in App Store Connect`,
      'Create the app in App Store Connect, or fix iap.apple.bundleId',
      ExitCode.precondition,
    )
  }
  const groups: AppleSubGroup[] = []
  for (const page of await pages(
    `v1/apps/${app.id}/subscriptionGroups`,
    { limit: 200, include: 'versions', 'limit[versions]': 50 },
    groupList,
  )) {
    const included = new Map((page.included ?? []).map((r) => [`${r.type}/${r.id}`, r.attributes ?? {}]))
    for (const r of page.data) {
      groups.push({
        ascId: r.id,
        referenceName: r.attributes.referenceName,
        ...versionOf(r.relationships?.versions, included),
        localizations: [],
        plans: [],
      })
    }
  }
  for (const g of groups) {
    ctx.groupIds.set(g.referenceName, g.ascId)
    for (const page of await pages(
      `v1/subscriptionGroups/${g.ascId}/subscriptions`,
      { limit: 200, include: 'appStoreReviewScreenshot,versions', 'limit[versions]': 50 },
      subList,
    )) {
      const included = new Map((page.included ?? []).map((r) => [`${r.type}/${r.id}`, r.attributes ?? {}]))
      for (const r of page.data) {
        const a = r.attributes
        const shotRef = r.relationships?.appStoreReviewScreenshot?.data
        const shot = shotRef ? included.get(`${shotRef.type}/${shotRef.id}`) : undefined
        g.plans.push({
          ascId: r.id,
          productId: a.productId,
          name: a.name,
          period: a.subscriptionPeriod ?? '',
          groupLevel: a.groupLevel ?? undefined,
          familySharable: a.familySharable ?? false,
          reviewNote: a.reviewNote ?? undefined,
          state: a.state ?? undefined,
          ...versionOf(r.relationships?.versions, included),
          localizations: [],
          prices: [],
          availability: false,
          offers: [],
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
        ctx.subIds.set(a.productId, r.id)
      }
    }
    if (!ctx.wanted.has(g.referenceName)) continue
    if (g.version) {
      for (const page of await pages(
        `v1/subscriptionGroupVersions/${g.version.id}/localizations`,
        { limit: 200 },
        localizationsResponse,
      )) {
        g.localizations.push(
          ...page.data.map((l) => ({ id: l.id, locale: l.attributes.locale, name: l.attributes.name ?? '' })),
        )
      }
    }
    for (const plan of g.plans) await planDetails(plan)
  }
  // A trial is one offer per territory: knowing them all shows a trial an earlier run left half made.
  const trials = groups.some((g) => g.plans.some((p) => p.offers.some((o) => o.mode === 'FREE_TRIAL')))
  const territories = trials ? await ctx.territories() : undefined
  return { appId: app.id, bundleId: ctx.bundleId, today, groups, ...(territories ? { territories } : {}) }
}
