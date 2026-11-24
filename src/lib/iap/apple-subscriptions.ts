import { readFileSync } from 'node:fs'
import {
  type AppleSubscriptionAction,
  type AppleSubscriptionsObserved,
  diffAppleSubscriptions,
} from './apple-subscriptions-diff'
import { createPager, DRAFT, observeSubscriptions, refused } from './apple-subscriptions-observe'
import {
  anyJson,
  created,
  localizationsResponse,
  pricePointsResponse,
  screenshotResponse,
  territoriesResponse,
  versionsResponse,
} from './apple-subscriptions-schemas'
import { type Client, StoreError } from './http'
import { type AppleScreenshot, type AppleSubscriptionDesired, samePrice } from './model'
import { ERROR_KIND, errorAction, type StoreAdapter } from './types'

/**
 * App Store Connect, auto-renewable subscriptions (plan-4 §5 Apple "Subscriptions", §14). One
 * subscription group per file subscription (reference name = its id), one subscription per plan.
 * Prices are set once on create from the USA price point and its equalizations; a changed USA price
 * on an existing plan needs `allowPriceChange` and keeps existing subscribers' price. Trials are
 * only ever created. Never deletes anything. Not run against a real account yet: the unverified
 * shapes (bulk price PATCH, plan vs deprecated availability, draft versions) each have a fallback.
 */

export { diffAppleSubscriptions } from './apple-subscriptions-diff'
export type {
  AppleSubGroup,
  AppleSubPlan,
  AppleSubscriptionAction,
  AppleSubscriptionsDiffOptions,
  AppleSubscriptionsObserved,
} from './apple-subscriptions-diff'

/** The three version-carrying resources localize the same way, under different paths. */
interface Localizable {
  versions: (id: string) => string
  versionType: string
  createVersion: string
  parentRel: string
  parentType: string
  list: (version: string) => string
  post: string
  type: string
}
const SUBSCRIPTION: Localizable = {
  versions: (id) => `v1/subscriptions/${id}/versions`,
  versionType: 'subscriptionVersions',
  createVersion: 'v1/subscriptionVersions',
  parentRel: 'subscription',
  parentType: 'subscriptions',
  list: (v) => `v1/subscriptionVersions/${v}/localizations`,
  post: 'v2/subscriptionLocalizations',
  type: 'subscriptionLocalizations',
}
const GROUP: Localizable = {
  versions: (id) => `v1/subscriptionGroups/${id}/versions`,
  versionType: 'subscriptionGroupVersions',
  createVersion: 'v1/subscriptionGroupVersions',
  parentRel: 'subscriptionGroup',
  parentType: 'subscriptionGroups',
  list: (v) => `v1/subscriptionGroupVersions/${v}/localizations`,
  post: 'v2/subscriptionGroupLocalizations',
  type: 'subscriptionGroupLocalizations',
}

// ---- adapter --------------------------------------------------------------------------------------

export interface AppleSubscriptionsAdapterOptions {
  bundleId: string
  /** `--allow-price-change`. */
  allowPriceChange: boolean
  sleep?: (ms: number) => Promise<void>
  /** Screenshot processing: poll every `pollMs` up to `pollLimitMs`. */
  pollMs?: number
  pollLimitMs?: number
  /** `YYYY-MM-DD` for "the price in effect"; default today (UTC). */
  today?: string
}

export function appleSubscriptionsAdapter(
  client: Client,
  opts: AppleSubscriptionsAdapterOptions,
): StoreAdapter<AppleSubscriptionDesired, AppleSubscriptionsObserved, AppleSubscriptionAction> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms))
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  let observed: AppleSubscriptionsObserved | undefined
  /** File subscription id → group id; product id → subscription id. */
  const groupIds = new Map<string, string>()
  const subIds = new Map<string, string>()
  const pointCache = new Map<string, Map<string, string>>()
  let territories: string[] | undefined

  const pages = createPager(client)

  const subId = (productId: string): string => {
    const id = subIds.get(productId)
    if (!id) throw new Error(`${productId} does not exist in App Store Connect yet`)
    return id
  }

  /** USA price points of one subscription, customerPrice → point id. */
  async function pricePoints(id: string): Promise<Map<string, string>> {
    const cached = pointCache.get(id)
    if (cached) return cached
    const points = new Map<string, string>()
    for (const page of await pages(
      `v1/subscriptions/${id}/pricePoints`,
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

  async function draftVersion(kind: Localizable, id: string): Promise<string> {
    const versions = (await pages(kind.versions(id), { limit: 50 }, versionsResponse)).flatMap((p) => p.data)
    const draft = versions.find((v) => v.attributes.state === DRAFT)
    if (draft) return draft.id
    const res = await client.request('POST', kind.createVersion, {
      body: {
        data: {
          type: kind.versionType,
          relationships: { [kind.parentRel]: { data: { type: kind.parentType, id } } },
        },
      },
      schema: created,
    })
    return res.data.id
  }

  async function localize(
    kind: Localizable,
    id: string,
    locales: Record<string, { name: string; description?: string }>,
  ): Promise<void> {
    const version = await draftVersion(kind, id)
    const have = (await pages(kind.list(version), { limit: 200 }, localizationsResponse)).flatMap(
      (x) => x.data,
    )
    for (const [locale, l] of Object.entries(locales)) {
      const attrs = { name: l.name, ...(l.description !== undefined ? { description: l.description } : {}) }
      const existing = have.find((x) => x.attributes.locale === locale)
      if (!existing) {
        await client.request('POST', kind.post, {
          body: {
            data: {
              type: kind.type,
              attributes: { locale, ...attrs },
              relationships: { version: { data: { type: kind.versionType, id: version } } },
            },
          },
          schema: created,
        })
      } else if (
        existing.attributes.name !== l.name ||
        (l.description !== undefined && existing.attributes.description !== l.description)
      ) {
        await client.request('PATCH', `${kind.post}/${existing.id}`, {
          body: { data: { type: kind.type, id: existing.id, attributes: attrs } },
          schema: anyJson,
        })
      }
    }
  }

  async function availability(id: string): Promise<void> {
    const all = (await allTerritories()).map((t) => ({ type: 'territories', id: t }))
    const rel = { subscription: { data: { type: 'subscriptions', id } }, availableTerritories: { data: all } }
    try {
      await client.request('POST', 'v1/subscriptionPlanAvailabilities', {
        body: {
          data: {
            type: 'subscriptionPlanAvailabilities',
            attributes: { planType: 'UPFRONT', availableInNewTerritories: true },
            relationships: rel,
          },
        },
        schema: anyJson,
      })
    } catch (e) {
      if (!refused(e)) throw e
      // Which endpoint plain UPFRONT needs is unverified: the deprecated one is the fallback.
      await client.request('POST', 'v1/subscriptionAvailabilities', {
        body: {
          data: {
            type: 'subscriptionAvailabilities',
            attributes: { availableInNewTerritories: true },
            relationships: rel,
          },
        },
        schema: anyJson,
      })
    }
  }

  /** One price per territory: the USA point and its equalizations. */
  async function setPrices(id: string, price: string, preserve: boolean): Promise<void> {
    const usa = findPoint(await pricePoints(id), price)
    if (!usa) throw new Error(`${price} is not an App Store price point in the USA`)
    const byTerritory = new Map<string, string>()
    for (const page of await pages(
      `v1/subscriptionPricePoints/${usa}/equalizations`,
      { include: 'territory', limit: 200 },
      pricePointsResponse,
    )) {
      for (const p of page.data) {
        const t = p.relationships?.territory?.data?.id
        if (t) byTerritory.set(t, p.id)
      }
    }
    byTerritory.delete('USA')
    // USA goes last: a run that dies half way leaves no USA price, so the next sync redoes it all.
    const entries = [...byTerritory.values(), usa]
    const attributes = {
      startDate: null,
      planType: 'UPFRONT',
      ...(preserve ? { preserveCurrentPrice: true } : {}),
    }
    const point = (p: string) => ({ data: { type: 'subscriptionPricePoints', id: p } })
    try {
      const inline = entries.map((p, i) => ({
        type: 'subscriptionPrices',
        id: `\${price-${i}}`,
        attributes,
        relationships: { subscriptionPricePoint: point(p) },
      }))
      await client.request('PATCH', `v1/subscriptions/${id}`, {
        body: {
          data: {
            type: 'subscriptions',
            id,
            relationships: { prices: { data: inline.map((x) => ({ type: x.type, id: x.id })) } },
          },
          included: inline,
        },
        schema: anyJson,
      })
    } catch (e) {
      if (!refused(e)) throw e
      for (const p of entries) {
        await client.request('POST', 'v1/subscriptionPrices', {
          body: {
            data: {
              type: 'subscriptionPrices',
              attributes,
              relationships: {
                subscription: { data: { type: 'subscriptions', id } },
                subscriptionPricePoint: point(p),
              },
            },
          },
          schema: anyJson,
        })
      }
    }
  }

  async function uploadScreenshot(id: string, shot: AppleScreenshot): Promise<void> {
    const reserved = await client.request('POST', 'v1/subscriptionAppStoreReviewScreenshots', {
      body: {
        data: {
          type: 'subscriptionAppStoreReviewScreenshots',
          attributes: { fileName: shot.fileName, fileSize: shot.size },
          relationships: { subscription: { data: { type: 'subscriptions', id } } },
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
      if (!res.ok) {
        throw new StoreError(
          'apple',
          res.status,
          undefined,
          `screenshot upload: ${(await res.text()).slice(0, 200)}`,
        )
      }
    }
    await client.request('PATCH', `v1/subscriptionAppStoreReviewScreenshots/${sid}`, {
      body: {
        data: {
          type: 'subscriptionAppStoreReviewScreenshots',
          id: sid,
          attributes: { uploaded: true, sourceFileChecksum: shot.md5 },
        },
      },
      schema: anyJson,
    })
    const limit = opts.pollLimitMs ?? 60_000
    const every = opts.pollMs ?? 2000
    for (let waited = 0; ; waited += every) {
      const s = await client.request('GET', `v1/subscriptionAppStoreReviewScreenshots/${sid}`, {
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
    label: `App Store Connect subscriptions (${opts.bundleId})`,

    async observe(desired) {
      observed = await observeSubscriptions(client, pages, {
        bundleId: opts.bundleId,
        today,
        wanted: new Set(desired.map((d) => d.id)),
        groupIds,
        subIds,
        territories: allTerritories,
      })
      return observed
    },

    diff: (desired, o, diffOpts) =>
      diffAppleSubscriptions(desired, o, {
        extras: diffOpts?.extras,
        allowPriceChange: opts.allowPriceChange,
      }),

    async prepare(actions) {
      // A price must be one of Apple's USA points. A plan that exists lists its own; a new plan
      // is checked against any existing subscription of the app (point ids differ, prices do not)
      // and, with none, only when the price is set after the create.
      const failed = new Map<string, string>()
      const anyExisting = [...subIds.values()][0]
      for (const a of actions) {
        if (a.kind !== 'price' || failed.has(a.id)) continue
        const p = a.payload as { plan: string; price: string }
        const existing = subIds.get(p.plan) ?? anyExisting
        if (!existing) continue
        if (!findPoint(await pricePoints(existing), p.price)) {
          failed.set(a.id, `${p.price} is not an App Store price point in the USA`)
        }
      }
      if (!failed.size) return actions
      const out: AppleSubscriptionAction[] = []
      for (const a of actions) {
        const why = failed.get(a.id)
        if (!why) out.push(a)
        else if (!out.some((x) => x.id === a.id && x.kind === ERROR_KIND)) {
          out.push(errorAction('apple', a.id, why))
        }
      }
      return out
    },

    async apply(action) {
      const p = action.payload as Record<string, unknown> | undefined
      switch (action.kind) {
        case ERROR_KIND:
          throw new Error((p as { message: string }).message)
        case 'group': {
          const res = await client.request('POST', 'v1/subscriptionGroups', {
            body: {
              data: {
                type: 'subscriptionGroups',
                attributes: { referenceName: action.id },
                relationships: { app: { data: { type: 'apps', id: observed!.appId } } },
              },
            },
            schema: created,
          })
          groupIds.set(action.id, res.data.id)
          return
        }
        case 'group-localizations': {
          const gid = groupIds.get(action.id)
          if (!gid) throw new Error(`subscription group ${action.id} does not exist in App Store Connect yet`)
          const locales = Object.fromEntries(
            Object.entries((p as { locales: Record<string, string> }).locales).map(([l, name]) => [
              l,
              { name },
            ]),
          )
          await localize(GROUP, gid, locales)
          return
        }
        case 'create': {
          const gid = groupIds.get(action.id)
          if (!gid) throw new Error(`subscription group ${action.id} does not exist in App Store Connect yet`)
          const { plan, attributes } = p as { plan: string; attributes: Record<string, unknown> }
          const res = await client.request('POST', 'v1/subscriptions', {
            body: {
              data: {
                type: 'subscriptions',
                attributes,
                relationships: { group: { data: { type: 'subscriptionGroups', id: gid } } },
              },
            },
            schema: created,
          })
          subIds.set(plan, res.data.id)
          return
        }
        case 'update': {
          const { plan, attributes } = p as { plan: string; attributes: Record<string, unknown> }
          const id = subId(plan)
          await client.request('PATCH', `v1/subscriptions/${id}`, {
            body: { data: { type: 'subscriptions', id, attributes } },
            schema: anyJson,
          })
          return
        }
        case 'localizations': {
          const { plan, locales } = p as {
            plan: string
            locales: Record<string, { name: string; description: string }>
          }
          await localize(SUBSCRIPTION, subId(plan), locales)
          return
        }
        case 'availability':
          await availability(subId((p as { plan: string }).plan))
          return
        case 'price': {
          const { plan, price, preserve } = p as { plan: string; price: string; preserve: boolean }
          await setPrices(subId(plan), price, preserve)
          return
        }
        case 'trial': {
          const {
            plan,
            duration,
            territories: only,
          } = p as {
            plan: string
            duration: string
            territories?: string[]
          }
          const id = subId(plan)
          for (const territory of only ?? (await allTerritories())) {
            await client.request('POST', 'v1/subscriptionIntroductoryOffers', {
              body: {
                data: {
                  type: 'subscriptionIntroductoryOffers',
                  attributes: { duration, offerMode: 'FREE_TRIAL', numberOfPeriods: 1 },
                  relationships: {
                    subscription: { data: { type: 'subscriptions', id } },
                    territory: { data: { type: 'territories', id: territory } },
                  },
                },
              },
              schema: anyJson,
            })
          }
          return
        }
        case 'screenshot': {
          const { plan, screenshot } = p as { plan: string; screenshot: AppleScreenshot }
          await uploadScreenshot(subId(plan), screenshot)
          return
        }
        default:
          throw new Error(`unknown Apple subscription action ${action.kind}`)
      }
    },
  }
}
