import { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import { type Client, StoreError } from './http'
import { type PlayDesired, samePrice } from './model'
import { type Action, type Diff, ERROR_KIND, errorAction, type StatusRow, type StoreAdapter } from './types'

/**
 * Google Play one-time products (Android Publisher v3 `monetization.onetimeproducts`, plan-4 §5
 * Play). No edits. Create and update are one PATCH (`allowMissing`) on the lowercase
 * `onetimeproducts` path; new purchase options start DRAFT and are activated after. "In sync"
 * compares listings, the buy option and the US price only: converted regional prices move with
 * exchange rates, so they are never diffed.
 */

const money = z.object({
  currencyCode: z.string(),
  units: z.string().optional(),
  nanos: z.number().optional(),
})
type Money = z.output<typeof money>

const option = z
  .object({
    purchaseOptionId: z.string(),
    state: z.string().optional(),
    buyOption: z
      .object({ legacyCompatible: z.boolean().optional(), multiQuantityEnabled: z.boolean().optional() })
      .passthrough()
      .optional(),
    rentOption: z.unknown().optional(),
    regionalPricingAndAvailabilityConfigs: z
      .array(
        z
          .object({ regionCode: z.string(), price: money.optional(), availability: z.string().optional() })
          .passthrough(),
      )
      .optional(),
    newRegionsConfig: z.unknown().optional(),
  })
  .passthrough()
type PlayOption = z.output<typeof option>

const product = z
  .object({
    productId: z.string(),
    listings: z
      .array(z.object({ languageCode: z.string(), title: z.string(), description: z.string().optional() }))
      .optional(),
    purchaseOptions: z.array(option).optional(),
  })
  .passthrough()

const listResponse = z.object({
  oneTimeProducts: z.array(product).optional(),
  nextPageToken: z.string().optional(),
})
const convertResponse = z.object({
  convertedRegionPrices: z.record(z.string(), z.object({ regionCode: z.string(), price: money })).optional(),
  convertedOtherRegionsPrice: z.object({ usdPrice: money, eurPrice: money }).optional(),
  regionVersion: z.object({ version: z.string() }),
})
const anyJson = z.unknown()

export interface PlayObserved {
  packageName: string
  products: z.output<typeof product>[]
}

/** `4.99` → `{ USD, units: '4', nanos: 990000000 }`. */
export function toMoney(price: string, currencyCode = 'USD'): Money {
  const [units, fraction = ''] = price.split('.')
  return { currencyCode, units: units!, nanos: Number(fraction.padEnd(9, '0').slice(0, 9)) }
}

export const moneyValue = (m: Money): number => Number(m.units ?? 0) + (m.nanos ?? 0) / 1e9

/** The US price of a purchase option, if it has one. */
export function usPrice(o: PlayOption | undefined): number | undefined {
  const us = o?.regionalPricingAndAvailabilityConfigs?.find((c) => c.regionCode === 'US')
  return us?.price ? moneyValue(us.price) : undefined
}

export type PlayAction = Action<{ convert: boolean } | { message: string }> | Action

export function diffPlay(
  desired: PlayDesired[],
  observed: PlayObserved,
  opts: { extras: boolean } = { extras: true },
): Diff<PlayAction> {
  const rows: StatusRow[] = []
  const actions: PlayAction[] = []
  const byId = new Map(observed.products.map((p) => [p.productId, p]))
  for (const d of desired) {
    const notes = d.scheduled.map((s) => `Play moves to ${s.price} on the first sync on or after ${s.from}`)
    const o = byId.get(d.productId)
    if (!o) {
      actions.push({
        store: 'play',
        id: d.productId,
        kind: 'upsert',
        summary: `create · price ${d.price} US (+ converted regions)`,
        payload: { convert: true },
      })
      actions.push({
        store: 'play',
        id: d.productId,
        kind: 'activate',
        summary: `activate ${d.purchaseOptionId}`,
      })
      rows.push({ store: 'play', id: d.productId, sync: 'missing', notes })
      continue
    }
    const fields: string[] = []
    for (const [lang, l] of Object.entries(d.listings)) {
      const have = o.listings?.find((x) => x.languageCode === lang)
      if (!have || have.title !== l.title || (have.description ?? '') !== l.description)
        fields.push(`listing ${lang}`)
    }
    for (const extra of (o.listings ?? []).filter((x) => !(x.languageCode in d.listings))) {
      notes.push(`listing ${extra.languageCode} is not in the file (kept)`)
    }
    const options = o.purchaseOptions ?? []
    const mine = options.find((x) => x.purchaseOptionId === d.purchaseOptionId)
    for (const x of options.filter((x) => x.purchaseOptionId !== d.purchaseOptionId)) {
      notes.push(`purchase option ${x.purchaseOptionId} is not in the file (kept)`)
    }
    const otherLegacy = options.find(
      (x) => x.purchaseOptionId !== d.purchaseOptionId && x.buyOption?.legacyCompatible,
    )
    let convert = false
    if (!mine) {
      fields.push(`purchase option ${d.purchaseOptionId}`)
      convert = true
    } else {
      if (!mine.buyOption?.legacyCompatible) fields.push('legacyCompatible')
      const us = usPrice(mine)
      if (us === undefined || !samePrice(us, d.price)) {
        fields.push('price')
        convert = true
      }
    }
    const errors: string[] = []
    if (mine?.rentOption)
      errors.push(`purchase option ${d.purchaseOptionId} is a rent option; kit manages a buy option`)
    if (otherLegacy && (!mine || !mine.buyOption?.legacyCompatible)) {
      errors.push(
        `purchase option ${otherLegacy.purchaseOptionId} is the backwards-compatible one; unmark it in Play Console so ${d.purchaseOptionId} can be (RevenueCat reads that one)`,
      )
    }
    if (errors.length) actions.push(errorAction('play', d.productId, errors.join('; ')))
    if (fields.length) {
      const what = fields.map((f) => (f === 'price' ? `price ${d.price} US` : f)).join(' · ')
      actions.push({
        store: 'play',
        id: d.productId,
        kind: 'upsert',
        summary: `update ${what}`,
        payload: { convert },
      })
    }
    if (mine?.state !== 'ACTIVE') {
      fields.push('state')
      actions.push({
        store: 'play',
        id: d.productId,
        kind: 'activate',
        summary: `activate ${d.purchaseOptionId}`,
      })
    }
    rows.push({
      store: 'play',
      id: d.productId,
      sync: fields.length ? 'differs' : 'in-sync',
      ...(fields.length ? { fields } : {}),
      storeState: mine?.state,
      notes,
    })
  }
  if (opts.extras) {
    const wanted = new Set(desired.map((d) => d.productId))
    for (const o of observed.products) {
      if (!wanted.has(o.productId)) {
        rows.push({
          store: 'play',
          id: o.productId,
          sync: 'extra',
          storeState: o.purchaseOptions
            ?.map((x) => `${x.purchaseOptionId} ${x.state ?? ''}`.trim())
            .join(', '),
          notes: ['not in the file (left alone)'],
        })
      }
    }
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
        `${e.message}. Play needs a payments profile and an app bundle that declares com.android.vending.BILLING on a track (kit release android --track internal) before products`,
      )
    }
    throw e
  }
}

/** Strip what Play marks output-only before sending an option back. */
function writable(o: PlayOption): PlayOption {
  const { state: _state, ...rest } = o
  return rest as PlayOption
}

export function playAdapter(
  client: Client,
  opts: { packageName: string },
): StoreAdapter<PlayDesired, PlayObserved, PlayAction> {
  const pkg = opts.packageName
  const app = `applications/${encodeURIComponent(pkg)}`
  let observed: PlayObserved | undefined
  let desiredById = new Map<string, PlayDesired>()
  let cachedVersion: string | undefined

  async function convert(price: string) {
    const res = await client.request('POST', `${app}/pricing:convertRegionPrices`, {
      body: { price: toMoney(price) },
      schema: convertResponse,
    })
    cachedVersion = res.regionVersion.version
    return res
  }

  return {
    store: 'play',
    label: `Google Play (${pkg})`,

    async observe(desired) {
      desiredById = new Map(desired.map((d) => [d.productId, d]))
      const products: PlayObserved['products'] = []
      let token: string | undefined
      do {
        let page: z.output<typeof listResponse>
        try {
          page = await client.request('GET', `${app}/oneTimeProducts`, {
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
        products.push(...(page.oneTimeProducts ?? []))
        token = page.nextPageToken || undefined
      } while (token)
      observed = { packageName: pkg, products }
      return observed
    },

    diff: (desired, o, diffOpts) => diffPlay(desired, o, diffOpts),

    async apply(action) {
      const d = desiredById.get(action.id)
      if (action.kind === ERROR_KIND) throw new Error((action.payload as { message: string }).message)
      if (!d) throw new Error(`${action.id} is not in the file`)
      if (action.kind === 'activate') {
        await withHint(() =>
          client.request(
            'POST',
            `${app}/oneTimeProducts/${encodeURIComponent(d.productId)}/purchaseOptions:batchUpdateStates`,
            {
              body: {
                requests: [
                  {
                    activatePurchaseOptionRequest: {
                      packageName: pkg,
                      productId: d.productId,
                      purchaseOptionId: d.purchaseOptionId,
                    },
                  },
                ],
              },
              schema: anyJson,
            },
          ),
        )
        return
      }
      if (action.kind !== 'upsert') throw new Error(`unknown Play action ${action.kind}`)
      const { convert: reconvert } = action.payload as { convert: boolean }
      const existing = observed?.products.find((p) => p.productId === d.productId)
      const mine = existing?.purchaseOptions?.find((x) => x.purchaseOptionId === d.purchaseOptionId)

      let regional: PlayOption['regionalPricingAndAvailabilityConfigs']
      let newRegionsConfig: unknown
      let version: string
      if (reconvert || !mine) {
        const c = await convert(d.price)
        version = c.regionVersion.version
        regional = Object.values(c.convertedRegionPrices ?? {}).map((r) => ({
          regionCode: r.regionCode,
          // The US price is the file's, exactly: it is what "in sync" compares.
          price: r.regionCode === 'US' ? toMoney(d.price) : r.price,
          availability: 'AVAILABLE',
        }))
        if (!regional.some((r) => r.regionCode === 'US')) {
          regional.push({ regionCode: 'US', price: toMoney(d.price), availability: 'AVAILABLE' })
        }
        newRegionsConfig = c.convertedOtherRegionsPrice
          ? { ...c.convertedOtherRegionsPrice, availability: 'AVAILABLE' }
          : mine?.newRegionsConfig
      } else {
        // Listings or flags only: the regional prices go back as Play has them.
        regional = mine.regionalPricingAndAvailabilityConfigs
        newRegionsConfig = mine.newRegionsConfig
        version = cachedVersion ?? (await convert(d.price)).regionVersion.version
      }

      const ours: PlayOption = {
        ...(mine ? writable(mine) : {}),
        purchaseOptionId: d.purchaseOptionId,
        buyOption: {
          ...mine?.buyOption,
          legacyCompatible: true,
          multiQuantityEnabled: mine?.buyOption?.multiQuantityEnabled ?? false,
        },
        regionalPricingAndAvailabilityConfigs: regional,
        ...(newRegionsConfig ? { newRegionsConfig } : {}),
      }
      const others = (existing?.purchaseOptions ?? [])
        .filter((x) => x.purchaseOptionId !== d.purchaseOptionId)
        .map(writable)
      const listings = [
        ...Object.entries(d.listings).map(([languageCode, l]) => ({
          languageCode,
          title: l.title,
          description: l.description,
        })),
        ...(existing?.listings ?? []).filter((x) => !(x.languageCode in d.listings)),
      ]
      await withHint(() =>
        client.request('PATCH', `${app}/onetimeproducts/${encodeURIComponent(d.productId)}`, {
          query: {
            allowMissing: true,
            updateMask: 'listings,purchaseOptions',
            'regionsVersion.version': version,
          },
          body: { packageName: pkg, productId: d.productId, listings, purchaseOptions: [ours, ...others] },
          schema: anyJson,
        }),
      )
    },
  }
}
