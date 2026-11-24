import { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import { type Client, StoreError } from './http'
import type { RcDesired } from './model'
import { type Action, type Diff, ERROR_KIND, errorAction, type StatusRow, type StoreAdapter } from './types'

/**
 * RevenueCat API v2 catalog (plan-4 §5 RevenueCat): one product per store app, one entitlement
 * per lookup key, the file's products attached to it. Never detaches, archives or deletes;
 * archived products or entitlements in the way fail with "unarchive it in RevenueCat".
 */

const list = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next_page: z.string().nullish() })

const app = z.object({
  id: z.string(),
  type: z.string(),
  app_store: z.object({ bundle_id: z.string().nullish() }).nullish(),
  play_store: z.object({ package_name: z.string().nullish() }).nullish(),
})
const product = z.object({
  id: z.string(),
  store_identifier: z.string(),
  type: z.string(),
  state: z.string().nullish(),
  app_id: z.string(),
  display_name: z.string().nullish(),
  one_time: z.object({ is_consumable: z.boolean().nullish() }).nullish(),
})
const entitlement = z.object({
  id: z.string(),
  lookup_key: z.string(),
  display_name: z.string().nullish(),
  state: z.string().nullish(),
})
const anyJson = z.unknown()

type RcProduct = z.output<typeof product>
type RcEntitlement = z.output<typeof entitlement>
type AppStore = 'apple' | 'play'

export interface RcObserved {
  projectId: string
  apps: Partial<Record<AppStore, string>>
  products: RcProduct[]
  entitlements: RcEntitlement[]
  /** Entitlement id → attached product ids (only entitlements the file uses). */
  attached: Record<string, string[]>
}

export interface RcTargets {
  projectId: string
  bundleId?: string
  packageName?: string
}

const APP_STORES: AppStore[] = ['apple', 'play']
const STORE_WORD: Record<AppStore, string> = { apple: 'App Store', play: 'Play Store' }
const ARCHIVED = 'inactive'

export type RcAction = Action

/**
 * RevenueCat reports some one-time products as `one_time` (with `one_time.is_consumable`) rather
 * than `consumable` / `non_consumable`: both mean the file's type when the consumable flag agrees.
 */
function sameType(
  p: { type: string; one_time?: { is_consumable?: boolean | null } | null },
  want: string,
): boolean {
  if (p.type === want) return true
  if (p.type !== 'one_time' || want === 'subscription') return false
  const consumable = p.one_time?.is_consumable
  return consumable == null || consumable === (want === 'consumable')
}

export function diffRevenuecat(
  desired: RcDesired[],
  observed: RcObserved,
  opts: { extras: boolean } = { extras: true },
): Diff<RcAction> {
  const rows: StatusRow[] = []
  const actions: RcAction[] = []
  const plannedEntitlements = new Set<string>()
  const fileIds = new Set(desired.flatMap((d) => [d.apple, d.play].filter((x) => x !== undefined)))
  const findProduct = (store: AppStore, storeId: string) =>
    observed.products.find((p) => p.app_id === observed.apps[store] && p.store_identifier === storeId)

  for (const d of desired) {
    const fields: string[] = []
    const errors: string[] = []
    const mine: RcAction[] = []
    let existing = 0
    const toAttach: string[] = []
    const ent = observed.entitlements.find((e) => e.lookup_key === d.entitlement)
    const attached = new Set(ent ? (observed.attached[ent.id] ?? []) : [])

    for (const store of APP_STORES) {
      const storeId = d[store]
      if (storeId === undefined || !observed.apps[store]) continue
      const p = findProduct(store, storeId)
      if (!p) {
        fields.push(`product ${store}`)
        mine.push({
          store: 'revenuecat',
          id: d.id,
          kind: 'product',
          summary: `product ${store}`,
          payload: {
            store,
            app_id: observed.apps[store],
            store_identifier: storeId,
            type: d.type,
            display_name: d.displayName,
          },
        })
        toAttach.push(`${store}:${storeId}`)
        continue
      }
      existing++
      if (p.state === ARCHIVED)
        errors.push(`the ${STORE_WORD[store]} product ${storeId} is archived: unarchive it in RevenueCat`)
      if (!sameType(p, d.type)) {
        fields.push(`type ${store}`)
        errors.push(
          `the ${STORE_WORD[store]} product ${storeId} is type ${p.type}, the file says ${d.type}; change it in RevenueCat`,
        )
      }
      if ((p.display_name ?? '') !== d.displayName) {
        fields.push(`display name ${store}`)
        mine.push({
          store: 'revenuecat',
          id: d.id,
          kind: 'rename',
          summary: `rename ${store}`,
          payload: { productId: p.id, display_name: d.displayName },
        })
      }
      if (!attached.has(p.id)) toAttach.push(`${store}:${storeId}`)
    }

    if (!ent) {
      fields.push('entitlement')
      // Planned on the first product that can run: an erroring product skips its actions.
      if (!plannedEntitlements.has(d.entitlement) && !errors.length) {
        plannedEntitlements.add(d.entitlement)
        mine.unshift({
          store: 'revenuecat',
          id: d.id,
          kind: 'entitlement',
          summary: `entitlement ${d.entitlement}`,
          payload: { lookup_key: d.entitlement, display_name: d.entitlementName },
        })
      }
    } else if (ent.state === ARCHIVED) {
      errors.push(`entitlement ${d.entitlement} is archived: unarchive it in RevenueCat`)
    }
    if (toAttach.length) {
      if (ent) fields.push('attach')
      mine.push({
        store: 'revenuecat',
        id: d.id,
        kind: 'attach',
        summary: `attach to ${d.entitlement}`,
        payload: { lookup_key: d.entitlement, products: toAttach },
      })
    }
    if (errors.length) actions.push(errorAction('revenuecat', d.id, errors.join('; ')))
    actions.push(...mine)

    const others = [...attached].filter((id) => {
      const p = observed.products.find((x) => x.id === id)
      return !p || !fileIds.has(p.store_identifier)
    })
    const notes = others.length
      ? [`${others.length} product(s) not in the file are attached to ${d.entitlement} (kept)`]
      : []
    rows.push({
      store: 'revenuecat',
      id: d.id,
      sync: existing === 0 && fields.length ? 'missing' : fields.length ? 'differs' : 'in-sync',
      ...(fields.length && existing > 0 ? { fields } : {}),
      storeState: ent && !toAttach.length ? `attached to ${d.entitlement}` : 'not attached',
      notes,
    })
  }

  if (opts.extras) {
    const wanted = new Set(desired.flatMap((d) => APP_STORES.map((s) => `${observed.apps[s]}:${d[s]}`)))
    for (const p of observed.products) {
      const store = APP_STORES.find((s) => observed.apps[s] === p.app_id)
      if (store && !wanted.has(`${p.app_id}:${p.store_identifier}`)) {
        rows.push({
          store: 'revenuecat',
          id: p.store_identifier,
          sync: 'extra',
          storeState: `${store} ${p.type}${p.state === ARCHIVED ? ' (archived)' : ''}`,
          notes: ['not in the file (left alone)'],
        })
      }
    }
  }
  return { rows, actions }
}

export function revenuecatAdapter(
  client: Client,
  t: RcTargets,
): StoreAdapter<RcDesired, RcObserved, RcAction> {
  const project = `projects/${encodeURIComponent(t.projectId)}`
  const productIds = new Map<string, string>()
  const entitlementIds = new Map<string, string>()

  async function all<T extends z.ZodType>(path: string, item: T): Promise<z.output<T>[]> {
    const out: z.output<T>[] = []
    let next: string | undefined = path
    let query: Record<string, number> | undefined = { limit: 100 }
    while (next) {
      const page: { items: z.output<T>[]; next_page?: string | null } = await client.request('GET', next, {
        query,
        schema: list(item),
      })
      out.push(...page.items)
      // `next_page` is a path from the API root (`/v2/projects/…`); the client's base already ends in /v2.
      next = page.next_page ? page.next_page.replace(/^\/?v2\//, '') : undefined
      query = undefined
    }
    return out
  }

  const archivedHint = (e: unknown): never => {
    if (e instanceof StoreError && e.code === 'entity_references_archived_entities') {
      throw new Error(`${e.message}: unarchive it in RevenueCat (kit never unarchives)`)
    }
    throw e
  }

  return {
    store: 'revenuecat',
    label: `RevenueCat (${t.projectId})`,

    async observe(desired) {
      const apps = await all(`${project}/apps`, app)
      const found: RcObserved['apps'] = {}
      const missing: string[] = []
      if (t.bundleId) {
        const a = apps.find((x) => x.type === 'app_store' && x.app_store?.bundle_id === t.bundleId)
        if (a) found.apple = a.id
        else missing.push(`the App Store app ${t.bundleId}`)
      }
      if (t.packageName) {
        const a = apps.find((x) => x.type === 'play_store' && x.play_store?.package_name === t.packageName)
        if (a) found.play = a.id
        else missing.push(`the Play Store app ${t.packageName}`)
      }
      if (missing.length) {
        throw new KitError(
          `RevenueCat project ${t.projectId} is missing ${missing.join(' and ')}`,
          'Connect the store apps in RevenueCat first (Project settings → Apps)',
          ExitCode.precondition,
        )
      }
      const products = await all(`${project}/products`, product)
      const entitlements = await all(`${project}/entitlements`, entitlement)
      const used = new Set(desired.map((d) => d.entitlement))
      const attached: RcObserved['attached'] = {}
      for (const e of entitlements.filter((x) => used.has(x.lookup_key))) {
        attached[e.id] = (await all(`${project}/entitlements/${e.id}/products`, product)).map((p) => p.id)
      }
      for (const p of products) {
        const store = APP_STORES.find((s) => found[s] === p.app_id)
        if (store) productIds.set(`${store}:${p.store_identifier}`, p.id)
      }
      for (const e of entitlements) entitlementIds.set(e.lookup_key, e.id)
      return { projectId: t.projectId, apps: found, products, entitlements, attached }
    },

    diff: (desired, o, diffOpts) => diffRevenuecat(desired, o, diffOpts),

    async apply(action) {
      const p = action.payload as Record<string, unknown>
      switch (action.kind) {
        case ERROR_KIND:
          throw new Error(p.message as string)
        case 'product': {
          const { store, ...body } = p
          const res = await client.request('POST', `${project}/products`, { body, schema: product })
          productIds.set(`${store as string}:${body.store_identifier as string}`, res.id)
          return
        }
        case 'rename':
          await client.request('POST', `${project}/products/${p.productId as string}`, {
            body: { display_name: p.display_name },
            schema: anyJson,
          })
          return
        case 'entitlement': {
          const res = await client.request('POST', `${project}/entitlements`, {
            body: { lookup_key: p.lookup_key, display_name: p.display_name },
            schema: entitlement,
          })
          entitlementIds.set(res.lookup_key, res.id)
          return
        }
        case 'attach': {
          const ent = entitlementIds.get(p.lookup_key as string)
          if (!ent) throw new Error(`entitlement ${p.lookup_key as string} does not exist in RevenueCat`)
          const ids = (p.products as string[]).map((key) => {
            const id = productIds.get(key)
            if (!id) throw new Error(`product ${key} does not exist in RevenueCat`)
            return id
          })
          await client
            .request('POST', `${project}/entitlements/${ent}/actions/attach_products`, {
              body: { product_ids: ids },
              schema: anyJson,
            })
            .catch(archivedHint)
          return
        }
        default:
          throw new Error(`unknown RevenueCat action ${action.kind}`)
      }
    },
  }
}
