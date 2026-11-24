import { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import { type Client, StoreError } from './http'
import { type PlayBasePlanDesired, type PlaySubscriptionDesired, samePrice } from './model'
import { moneyValue, toMoney } from './play'
import { type Action, type Diff, ERROR_KIND, errorAction, type StatusRow, type StoreAdapter } from './types'

/**
 * Google Play subscriptions (Android Publisher v3 `monetization.subscriptions`, plan-4 §5 Play,
 * "Subscriptions"). One PATCH (`allowMissing`) per subscription carries the listings and
 * every base plan; base plans start DRAFT and are activated after. Compared: listings, the base plan
 * set, billing period, the legacy flag, the US price and the `free-trial` offer. Converted regional
 * prices move with exchange rates and are never diffed. Nothing is ever deleted or deactivated, a
 * trial that differs is left to Play Console, and `basePlans:migratePrices` is never called.
 */

export const TRIAL_OFFER_ID = 'free-trial'

const money = z.object({
  currencyCode: z.string(),
  units: z.string().optional(),
  nanos: z.number().optional(),
})

const basePlan = z
  .object({
    basePlanId: z.string(),
    state: z.string().optional(),
    autoRenewingBasePlanType: z
      .object({ billingPeriodDuration: z.string().optional(), legacyCompatible: z.boolean().optional() })
      .passthrough()
      .optional(),
    regionalConfigs: z
      .array(z.object({ regionCode: z.string(), price: money.optional() }).passthrough())
      .optional(),
    otherRegionsConfig: z.unknown().optional(),
  })
  .passthrough()
type PlayBasePlan = z.output<typeof basePlan>

const subscription = z
  .object({
    productId: z.string(),
    listings: z
      .array(
        z.object({
          languageCode: z.string(),
          title: z.string(),
          description: z.string().optional(),
          benefits: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    basePlans: z.array(basePlan).optional(),
  })
  .passthrough()
type PlaySubscription = z.output<typeof subscription>

const offer = z
  .object({
    offerId: z.string(),
    state: z.string().optional(),
    phases: z
      .array(
        z
          .object({ duration: z.string().optional(), regionalConfigs: z.array(z.unknown()).optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()
type PlayOffer = z.output<typeof offer>

const listResponse = z.object({
  subscriptions: z.array(subscription).optional(),
  nextPageToken: z.string().optional(),
})
const offersResponse = z.object({
  subscriptionOffers: z.array(offer).optional(),
  nextPageToken: z.string().optional(),
})
const convertResponse = z.object({
  convertedRegionPrices: z.record(z.string(), z.object({ regionCode: z.string(), price: money })).optional(),
  convertedOtherRegionsPrice: z.object({ usdPrice: money, eurPrice: money }).optional(),
  regionVersion: z.object({ version: z.string() }),
})
const anyJson = z.unknown()

export interface PlaySubscriptionsObserved {
  packageName: string
  subscriptions: PlaySubscription[]
  /** Offers per `subscription/basePlan`, for the base plans the file names that exist in Play. */
  offers: Record<string, PlayOffer[]>
}

export const offersKey = (sub: string, plan: string) => `${sub}/${plan}`

export type PlaySubscriptionAction =
  | Action<{ convertPlans: string[] }>
  | Action<{ basePlanId: string; trial?: string }>
  | Action<{ message: string }>
  | Action

const planType = (p: PlayBasePlan | undefined) => p?.autoRenewingBasePlanType
const usPrice = (p: PlayBasePlan): number | undefined => {
  const c = p.regionalConfigs?.find((r) => r.regionCode === 'US')
  return c?.price ? moneyValue(c.price) : undefined
}

/** A free trial of exactly one phase of `duration` (the shape kit writes). */
const isTrial = (o: PlayOffer, duration: string) =>
  o.phases?.length === 1 &&
  o.phases[0]!.duration === duration &&
  (o.phases[0]!.regionalConfigs ?? []).every((r) => !!r && typeof r === 'object' && 'free' in r)

/**
 * Action order per subscription: `error`, `upsert`, `activate` (one per DRAFT or new base plan),
 * `trial` (create the offer) and `activate-offer`. Row fields name the plan (`yearly: price`).
 */
export function diffPlaySubscriptions(
  desired: PlaySubscriptionDesired[],
  observed: PlaySubscriptionsObserved,
  opts: { extras: boolean; allowPriceChange?: boolean } = { extras: true },
): Diff<PlaySubscriptionAction> {
  const rows: StatusRow[] = []
  const actions: PlaySubscriptionAction[] = []
  const byId = new Map(observed.subscriptions.map((s) => [s.productId, s]))
  for (const d of desired) {
    const o = byId.get(d.productId)
    const notes: string[] = []
    const trialActions: PlaySubscriptionAction[] = []
    const activations: PlaySubscriptionAction[] = []
    const errors: string[] = []
    const fields: string[] = []
    const convertPlans: string[] = []
    let upsert = !o

    const activateBasePlan = (p: PlayBasePlanDesired) =>
      activations.push({
        store: 'play',
        id: d.productId,
        kind: 'activate',
        summary: `activate base plan ${p.basePlanId}`,
        payload: { basePlanId: p.basePlanId },
      })
    const activateOffer = (p: PlayBasePlanDesired) =>
      trialActions.push({
        store: 'play',
        id: d.productId,
        kind: 'activate-offer',
        summary: `activate ${p.basePlanId} ${TRIAL_OFFER_ID}`,
        payload: { basePlanId: p.basePlanId },
      })
    const createTrial = (p: PlayBasePlanDesired) => {
      trialActions.push({
        store: 'play',
        id: d.productId,
        kind: 'trial',
        summary: `create ${p.basePlanId} ${TRIAL_OFFER_ID} ${p.trial}`,
        payload: { basePlanId: p.basePlanId, trial: p.trial },
      })
      activateOffer(p)
    }

    if (o) {
      for (const [lang, l] of Object.entries(d.listings)) {
        const have = o.listings?.find((x) => x.languageCode === lang)
        if (
          !have ||
          have.title !== l.title ||
          (have.description ?? '') !== l.description ||
          JSON.stringify(have.benefits ?? []) !== JSON.stringify(l.benefits)
        )
          fields.push(`listing ${lang}`)
      }
      for (const x of (o.listings ?? []).filter((x) => !(x.languageCode in d.listings)))
        notes.push(`listing ${x.languageCode} is not in the file (kept)`)
    }
    const plans = o?.basePlans ?? []
    for (const x of plans.filter((x) => !d.basePlans.some((p) => p.basePlanId === x.basePlanId)))
      notes.push(`base plan ${x.basePlanId} is not in the file (kept)`)
    if (fields.length) upsert = true

    for (const p of d.basePlans) {
      const mine = plans.find((x) => x.basePlanId === p.basePlanId)
      if (!mine) {
        if (o) fields.push(`${p.basePlanId}: base plan`)
        convertPlans.push(p.basePlanId)
        upsert = true
        activateBasePlan(p)
        if (p.trial) createTrial(p)
        continue
      }
      const period = planType(mine)?.billingPeriodDuration
      if (!planType(mine))
        errors.push(`base plan ${p.basePlanId} is not auto-renewing; kit manages auto-renewing base plans`)
      else if (period !== p.period)
        errors.push(
          `base plan ${p.basePlanId} bills every ${period ?? '?'} in Play and the file says ${p.period}; a billing period cannot change after create (use a new plan id)`,
        )
      if (p.legacyCompatible && !planType(mine)?.legacyCompatible) {
        fields.push(`${p.basePlanId}: legacyCompatible`)
        upsert = true
        const other = plans.find((x) => x.basePlanId !== p.basePlanId && planType(x)?.legacyCompatible)
        if (other)
          errors.push(
            `base plan ${other.basePlanId} is the backwards-compatible one; unmark it in Play Console so ${p.basePlanId} can be (RevenueCat reads that one)`,
          )
      }
      const have = usPrice(mine)
      if (have === undefined || !samePrice(have, p.price)) {
        fields.push(`${p.basePlanId}: price`)
        if (opts.allowPriceChange) {
          convertPlans.push(p.basePlanId)
          upsert = true
          notes.push(`${p.basePlanId}: price ${p.price} US applies to new subscribers only`)
        } else {
          notes.push(
            `${p.basePlanId}: price ${have ?? '?'} in Play, ${p.price} in the file; needs --allow-price-change; new subscribers only`,
          )
        }
      }
      if (mine.state === 'DRAFT') activateBasePlan(p)
      else if (mine.state === 'INACTIVE') notes.push(`base plan ${p.basePlanId} is inactive (left alone)`)

      const offers = observed.offers[offersKey(d.productId, p.basePlanId)] ?? []
      for (const x of offers.filter((x) => x.offerId !== TRIAL_OFFER_ID))
        notes.push(`offer ${p.basePlanId}/${x.offerId} is not in the file (kept)`)
      const trial = offers.find((x) => x.offerId === TRIAL_OFFER_ID)
      if (p.trial && !trial) {
        fields.push(`${p.basePlanId}: trial`)
        createTrial(p)
      } else if (p.trial && trial) {
        if (!isTrial(trial, p.trial)) {
          fields.push(`${p.basePlanId}: trial`)
          notes.push(`${p.basePlanId}: trial differs; change it in Play Console`)
        } else if (trial.state === 'DRAFT') {
          fields.push(`${p.basePlanId}: trial state`)
          activateOffer(p)
        }
      } else if (!p.trial && trial)
        notes.push(`offer ${p.basePlanId}/${TRIAL_OFFER_ID} is not in the file (kept)`)
    }

    if (errors.length) actions.push(errorAction('play', d.productId, errors.join('; ')))
    if (upsert) {
      const what = fields.filter((f) => !f.includes(': trial')).join(' · ')
      actions.push({
        store: 'play',
        id: d.productId,
        kind: 'upsert',
        summary: o
          ? `update ${what || 'base plans'}`
          : `create · ${d.basePlans.map((p) => `${p.basePlanId} ${p.price} US`).join(', ')} (+ converted regions)`,
        payload: { convertPlans },
      })
    }
    actions.push(...activations, ...trialActions)
    rows.push({
      store: 'play',
      id: d.productId,
      sync: !o ? 'missing' : fields.length ? 'differs' : 'in-sync',
      ...(o && fields.length ? { fields } : {}),
      ...(o ? { storeState: plans.map((x) => `${x.basePlanId} ${x.state ?? ''}`.trim()).join(', ') } : {}),
      notes,
    })
  }
  if (opts.extras) {
    const wanted = new Set(desired.map((d) => d.productId))
    for (const o of observed.subscriptions.filter((o) => !wanted.has(o.productId)))
      rows.push({
        store: 'play',
        id: o.productId,
        sync: 'extra',
        storeState: o.basePlans?.map((x) => `${x.basePlanId} ${x.state ?? ''}`.trim()).join(', '),
        notes: ['not in the file (left alone)'],
      })
  }
  return { rows, actions }
}

const PRECONDITION =
  /billing|merchant|payment|payments profile|publish|apk|bundle|not allowed to create|has no (app|apk)/i

/** A Play refusal that reads like a missing account or build gets the manual step as a hint. */
async function withHint<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof StoreError && e.status < 500 && PRECONDITION.test(e.detail)) {
      throw new Error(
        `${e.message}. Play needs a payments profile and an app bundle that declares com.android.vending.BILLING on a track (kit release android --track internal) before subscriptions`,
      )
    }
    throw e
  }
}

/** Strip what Play marks output-only before sending a base plan back. */
function writable(p: PlayBasePlan): PlayBasePlan {
  const { state: _state, ...rest } = p
  return rest as PlayBasePlan
}

export function playSubscriptionsAdapter(
  client: Client,
  opts: { packageName: string; allowPriceChange?: boolean },
): StoreAdapter<PlaySubscriptionDesired, PlaySubscriptionsObserved, PlaySubscriptionAction> {
  const pkg = opts.packageName
  const app = `applications/${encodeURIComponent(pkg)}`
  let desiredById = new Map<string, PlaySubscriptionDesired>()
  /** What Play last said about each subscription (observed, then each PATCH answer). */
  const known = new Map<string, PlaySubscription>()
  const converts = new Map<string, z.output<typeof convertResponse>>()
  let regionsVersion: string | undefined

  async function convert(price: string) {
    const hit = converts.get(price)
    if (hit) return hit
    const res = await client.request('POST', `${app}/pricing:convertRegionPrices`, {
      body: { price: toMoney(price) },
      schema: convertResponse,
    })
    regionsVersion = res.regionVersion.version
    converts.set(price, res)
    return res
  }

  const planPath = (sub: string, plan: string) =>
    `${app}/subscriptions/${encodeURIComponent(sub)}/basePlans/${encodeURIComponent(plan)}`

  async function patchSubscription(
    d: PlaySubscriptionDesired,
    body: Record<string, unknown>,
    updateMask: string,
    version: string,
  ) {
    const res = await withHint(() =>
      client.request('PATCH', `${app}/subscriptions/${encodeURIComponent(d.productId)}`, {
        query: { allowMissing: true, updateMask, 'regionsVersion.version': version },
        body: { packageName: pkg, productId: d.productId, ...body },
        schema: anyJson,
      }),
    )
    const parsed = subscription.safeParse(res)
    if (parsed.success) known.set(d.productId, parsed.data)
  }

  async function upsert(d: PlaySubscriptionDesired, convertPlans: string[]) {
    const existing = known.get(d.productId)
    const plans: PlayBasePlan[] = []
    for (const p of d.basePlans) {
      const mine = existing?.basePlans?.find((x) => x.basePlanId === p.basePlanId)
      let regionalConfigs: unknown = mine?.regionalConfigs
      let otherRegionsConfig: unknown = mine?.otherRegionsConfig
      if (!mine || convertPlans.includes(p.basePlanId)) {
        const c = await convert(p.price)
        const regional = Object.values(c.convertedRegionPrices ?? {}).map((r) => ({
          regionCode: r.regionCode,
          // The US price is the file's, exactly: it is what "in sync" compares.
          price: r.regionCode === 'US' ? toMoney(p.price) : r.price,
          newSubscriberAvailability: true,
        }))
        if (!regional.some((r) => r.regionCode === 'US'))
          regional.push({ regionCode: 'US', price: toMoney(p.price), newSubscriberAvailability: true })
        regionalConfigs = regional
        otherRegionsConfig = c.convertedOtherRegionsPrice
          ? { ...c.convertedOtherRegionsPrice, newSubscriberAvailability: true }
          : mine?.otherRegionsConfig
      }
      const type = planType(mine)
      plans.push({
        ...(mine ? writable(mine) : {}),
        basePlanId: p.basePlanId,
        autoRenewingBasePlanType: {
          resubscribeState: 'RESUBSCRIBE_STATE_ACTIVE',
          ...type,
          billingPeriodDuration: type?.billingPeriodDuration ?? p.period,
          ...(p.legacyCompatible ? { legacyCompatible: true } : {}),
        },
        regionalConfigs,
        ...(otherRegionsConfig ? { otherRegionsConfig } : {}),
      } as PlayBasePlan)
    }
    const others = (existing?.basePlans ?? [])
      .filter((x) => !d.basePlans.some((p) => p.basePlanId === x.basePlanId))
      .map(writable)
    const version = regionsVersion ?? (await convert(d.basePlans[0]!.price)).regionVersion.version
    const listings = [
      ...Object.entries(d.listings).map(([languageCode, l]) => ({ languageCode, ...l })),
      ...(existing?.listings ?? []).filter((x) => !(x.languageCode in d.listings)),
    ]
    const basePlans = [...plans, ...others]
    try {
      await patchSubscription(d, { listings, basePlans }, 'listings,basePlans', version)
    } catch (e) {
      // Unverified whether Play takes base plans with a brand-new subscription in one call. If it
      // refuses (a 4xx that is not a credentials or billing problem), create the subscription with
      // listings alone, then add the base plans.
      if (
        existing ||
        !(e instanceof StoreError) ||
        e.status >= 500 ||
        e.status === 401 ||
        e.status === 403 ||
        PRECONDITION.test(e.detail)
      )
        throw e
      try {
        await patchSubscription(d, { listings }, 'listings', version)
        await patchSubscription(d, { listings, basePlans }, 'listings,basePlans', version)
      } catch (e2) {
        throw new Error(`${(e2 as Error).message} (the one-call create had failed first: ${e.message})`)
      }
    }
  }

  /** Region codes the base plan is sold in: an offer needs one config per region. */
  async function regionsOf(d: PlaySubscriptionDesired, basePlanId: string): Promise<string[]> {
    const p = known.get(d.productId)?.basePlans?.find((x) => x.basePlanId === basePlanId)
    const codes = p?.regionalConfigs?.map((r) => r.regionCode)
    if (codes?.length) return codes
    const plan = d.basePlans.find((x) => x.basePlanId === basePlanId)!
    return Object.values((await convert(plan.price)).convertedRegionPrices ?? {}).map((r) => r.regionCode)
  }

  return {
    store: 'play',
    label: `Google Play subscriptions (${pkg})`,

    async observe(desired) {
      desiredById = new Map(desired.map((d) => [d.productId, d]))
      const subscriptions: PlaySubscription[] = []
      let token: string | undefined
      do {
        let page: z.output<typeof listResponse>
        try {
          page = await client.request('GET', `${app}/subscriptions`, {
            query: { pageSize: 1000, pageToken: token },
            schema: listResponse,
          })
        } catch (e) {
          if (e instanceof StoreError && e.status === 404) {
            throw new KitError(
              `Google Play has no app ${pkg} (or the service account cannot see it)`,
              'Create the app in Play Console and invite the service account, or fix iap.play.packageName',
              ExitCode.precondition,
            )
          }
          throw e
        }
        subscriptions.push(...(page.subscriptions ?? []))
        token = page.nextPageToken || undefined
      } while (token)
      const offers: PlaySubscriptionsObserved['offers'] = {}
      for (const d of desired) {
        const s = subscriptions.find((x) => x.productId === d.productId)
        if (!s) continue
        known.set(s.productId, s)
        for (const p of d.basePlans.filter((p) => s.basePlans?.some((x) => x.basePlanId === p.basePlanId))) {
          const list: PlayOffer[] = []
          let t: string | undefined
          do {
            const page = await client.request('GET', `${planPath(d.productId, p.basePlanId)}/offers`, {
              query: { pageSize: 100, pageToken: t },
              schema: offersResponse,
            })
            list.push(...(page.subscriptionOffers ?? []))
            t = page.nextPageToken || undefined
          } while (t)
          offers[offersKey(d.productId, p.basePlanId)] = list
        }
      }
      return { packageName: pkg, subscriptions, offers }
    },

    diff: (desired, o, diffOpts) =>
      diffPlaySubscriptions(desired, o, {
        extras: diffOpts?.extras ?? true,
        allowPriceChange: opts.allowPriceChange,
      }),

    async apply(action) {
      if (action.kind === ERROR_KIND) throw new Error((action.payload as { message: string }).message)
      const d = desiredById.get(action.id)
      if (!d) throw new Error(`${action.id} is not in the file`)
      const payload = action.payload as { convertPlans: string[]; basePlanId: string; trial: string }
      if (action.kind === 'upsert') return upsert(d, payload.convertPlans)
      if (action.kind === 'activate') {
        await withHint(() =>
          client.request('POST', `${planPath(d.productId, payload.basePlanId)}:activate`, {
            body: { packageName: pkg, productId: d.productId, basePlanId: payload.basePlanId },
            schema: anyJson,
          }),
        )
        return
      }
      const offerPath = `${planPath(d.productId, payload.basePlanId)}/offers/${TRIAL_OFFER_ID}`
      if (action.kind === 'activate-offer') {
        await withHint(() =>
          client.request('POST', `${offerPath}:activate`, {
            body: {
              packageName: pkg,
              productId: d.productId,
              basePlanId: payload.basePlanId,
              offerId: TRIAL_OFFER_ID,
            },
            schema: anyJson,
          }),
        )
        return
      }
      if (action.kind !== 'trial') throw new Error(`unknown Play action ${action.kind}`)
      const regions = await regionsOf(d, payload.basePlanId)
      const version = regionsVersion ?? (await convert(d.basePlans[0]!.price)).regionVersion.version
      await withHint(() =>
        client.request('PATCH', offerPath, {
          query: {
            allowMissing: true,
            updateMask: 'phases,regionalConfigs,otherRegionsConfig,targeting',
            'regionsVersion.version': version,
          },
          body: {
            packageName: pkg,
            productId: d.productId,
            basePlanId: payload.basePlanId,
            offerId: TRIAL_OFFER_ID,
            phases: [
              {
                duration: payload.trial,
                recurrenceCount: 1,
                regionalConfigs: regions.map((regionCode) => ({ regionCode, free: {} })),
                otherRegionsConfig: { free: {} },
              },
            ],
            regionalConfigs: regions.map((regionCode) => ({ regionCode, newSubscriberAvailability: true })),
            otherRegionsConfig: { otherRegionsNewSubscriberAvailability: true },
            targeting: { acquisitionRule: { scope: { thisSubscription: {} } } },
          },
          schema: anyJson,
        }),
      )
    },
  }
}
