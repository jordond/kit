import { z } from 'zod'
import { ExitCode, KitError } from '../errors'
import { type Client, StoreError } from './http'
import type { RcDesired, RcOfferingDesired } from './model'
import { type Action, type Diff, ERROR_KIND, errorAction, type StatusRow, type StoreAdapter } from './types'

/**
 * RevenueCat offerings and packages (plan-4 §14). Offerings are optional: a file without them
 * makes no requests and needs no extra key scopes. Never detaches, archives or deletes; archived
 * entities in the way fail with "unarchive it in RevenueCat".
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
  type: z.string().nullish(),
  state: z.string().nullish(),
  app_id: z.string(),
})
const offering = z.object({
  id: z.string(),
  lookup_key: z.string(),
  display_name: z.string().nullish(),
  is_current: z.boolean().nullish(),
  state: z.string().nullish(),
})
const pkg = z.object({
  id: z.string(),
  lookup_key: z.string(),
  display_name: z.string().nullish(),
  position: z.number().nullish(),
  state: z.string().nullish(),
})
const anyJson = z.unknown()

type AppStore = 'apple' | 'play' | 'test'
type RcProduct = z.output<typeof product>
type RcOffering = z.output<typeof offering>
type RcPackage = z.output<typeof pkg>

export interface RcPackageObserved extends RcPackage {
  products: RcProduct[]
}

export interface RcOfferingsObserved {
  projectId: string
  apps: Partial<Record<AppStore, string>>
  offerings: RcOffering[]
  /** Offering lookup key → its packages (only offerings the file lists). */
  packages: Record<string, RcPackageObserved[]>
}

export interface RcOfferingsTargets {
  projectId: string
  bundleId?: string
  packageName?: string
  testStore?: boolean
  /** The RevenueCat products of the file (`rcDesired`): what a package's `product` points at. */
  products: RcDesired[]
}

export type RcOfferingAction = Action

const APP_STORES: AppStore[] = ['apple', 'play', 'test']
const STORE_WORD: Record<AppStore, string> = { apple: 'App Store', play: 'Play Store', test: 'Test Store' }
const ARCHIVED = new Set(['inactive', 'archived'])
const SCOPES =
  'Offerings also need project_configuration:offerings:read_write and project_configuration:packages:read_write on the RevenueCat secret key'

const rowId = (lookupKey: string) => `offering/${lookupKey}`

function act(id: string, kind: string, summary: string, payload: unknown): RcOfferingAction {
  return { store: 'revenuecat', id, kind, summary, payload }
}

export function diffRevenuecatOfferings(
  desired: RcOfferingDesired[],
  observed: RcOfferingsObserved,
  products: RcDesired[],
  opts: { extras: boolean } = { extras: true },
): Diff<RcOfferingAction> {
  const rows: StatusRow[] = []
  const actions: RcOfferingAction[] = []
  const currentLookup = observed.offerings.find((o) => o.is_current)?.lookup_key

  for (const d of desired) {
    const id = rowId(d.lookupKey)
    const fields: string[] = []
    const notes: string[] = []
    const errors: string[] = []
    const mine: RcOfferingAction[] = []
    const existing = observed.offerings.find((o) => o.lookup_key === d.lookupKey)
    const observedPackages = existing ? (observed.packages[d.lookupKey] ?? []) : []

    if (!existing) {
      mine.push(
        act(id, 'offering', `offering ${d.lookupKey}`, {
          lookup_key: d.lookupKey,
          display_name: d.displayName,
        }),
      )
    } else {
      if (ARCHIVED.has(existing.state ?? '')) {
        errors.push(`offering ${d.lookupKey} is archived: unarchive it in RevenueCat`)
      }
      if ((existing.display_name ?? '') !== d.displayName) {
        fields.push('name')
        mine.push(act(id, 'rename', 'rename', { offering: d.lookupKey, display_name: d.displayName }))
      }
    }

    for (const p of d.packages) {
      const file = products.find((x) => x.id === p.product)
      if (!file) {
        errors.push(`package ${p.lookupKey}: product ${p.product} is not in the file`)
        continue
      }
      const have = observedPackages.find((x) => x.lookup_key === p.lookupKey)
      const packageFields: string[] = []
      if (!have) {
        packageFields.push('create')
        mine.push(
          act(id, 'package', `package ${p.lookupKey}`, {
            offering: d.lookupKey,
            lookup_key: p.lookupKey,
            display_name: p.displayName,
            position: p.position,
          }),
        )
      } else {
        if (ARCHIVED.has(have.state ?? '')) {
          errors.push(`package ${p.lookupKey} is archived: unarchive it in RevenueCat`)
        }
        const update: Record<string, unknown> = {}
        if ((have.display_name ?? '') !== p.displayName) update.display_name = p.displayName
        if (have.position !== p.position) update.position = p.position
        if (Object.keys(update).length) {
          packageFields.push('update')
          mine.push(
            act(id, 'package-update', `package ${p.lookupKey} ${Object.keys(update).join(', ')}`, {
              offering: d.lookupKey,
              package: p.lookupKey,
              ...update,
            }),
          )
        }
      }

      const toAttach: AppStore[] = []
      for (const store of APP_STORES) {
        const wanted = file[store]
        const appId = observed.apps[store]
        if (wanted === undefined || !appId) continue
        const held = have?.products.find((x) => x.app_id === appId)
        if (!held) toAttach.push(store)
        else if (held.store_identifier !== wanted) {
          packageFields.push('product')
          notes.push(
            `package ${p.lookupKey} holds ${held.store_identifier} for ${STORE_WORD[store]}, the file says ${wanted} (kept; change it in RevenueCat)`,
          )
        }
      }
      if (toAttach.length) {
        packageFields.push('attach')
        mine.push(
          act(id, 'attach', `attach ${p.product} to ${p.lookupKey}`, {
            offering: d.lookupKey,
            package: p.lookupKey,
            product: p.product,
            stores: toAttach,
          }),
        )
      }
      if (packageFields.length) fields.push(`package ${p.lookupKey}`)
    }

    if (d.current && currentLookup !== d.lookupKey) {
      fields.push('current')
      mine.push(act(id, 'current', 'make current', { offering: d.lookupKey }))
    }

    const fileKeys = new Set(d.packages.map((p) => p.lookupKey))
    const extraPackages = observedPackages.filter((x) => !fileKeys.has(x.lookup_key))
    if (extraPackages.length) {
      notes.push(`package(s) not in the file (kept): ${extraPackages.map((x) => x.lookup_key).join(', ')}`)
    }

    if (errors.length) actions.push(errorAction('revenuecat', id, errors.join('; ')))
    actions.push(...mine)
    rows.push({
      store: 'revenuecat',
      id,
      sync: !existing ? 'missing' : fields.length ? 'differs' : 'in-sync',
      ...(existing && fields.length ? { fields } : {}),
      storeState: existing
        ? `${existing.is_current ? 'current, ' : ''}${observedPackages.length} package(s)`
        : 'not created',
      notes,
    })
  }

  if (opts.extras) {
    const wanted = new Set(desired.map((d) => d.lookupKey))
    for (const o of observed.offerings) {
      if (wanted.has(o.lookup_key)) continue
      rows.push({
        store: 'revenuecat',
        id: rowId(o.lookup_key),
        sync: 'extra',
        storeState: `${o.is_current ? 'current' : 'offering'}${ARCHIVED.has(o.state ?? '') ? ' (archived)' : ''}`,
        notes: ['not in the file (left alone)'],
      })
    }
  }
  return { rows, actions }
}

export function revenuecatOfferingsAdapter(
  rawClient: Client,
  t: RcOfferingsTargets,
): StoreAdapter<RcOfferingDesired, RcOfferingsObserved, RcOfferingAction> {
  const project = `projects/${encodeURIComponent(t.projectId)}`
  const offeringIds = new Map<string, string>()
  const packageIds = new Map<string, string>()
  let apps: RcOfferingsObserved['apps'] = {}

  // A 401/403 on these paths usually means the key lacks the offerings/packages scopes.
  const client: Client = {
    store: rawClient.store,
    base: rawClient.base,
    request: (method, path, opts) =>
      rawClient.request(method, path, opts).catch((e: unknown) => {
        if (e instanceof StoreError && (e.status === 401 || e.status === 403)) {
          throw new StoreError(
            e.store,
            e.status,
            e.code,
            e.detail,
            e.pointer,
            e.hint ? `${e.hint}. ${SCOPES}` : SCOPES,
            e.request,
          )
        }
        throw e
      }),
  }

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
      next = page.next_page ? page.next_page.replace(/^\/?v2\//, '') : undefined
      query = undefined
    }
    return out
  }

  const wrapArchived = (e: unknown): never => {
    if (e instanceof StoreError && e.code === 'entity_references_archived_entities') {
      throw new Error(`${e.message}: unarchive it in RevenueCat (kit never unarchives)`)
    }
    throw e
  }

  const offeringId = (key: string) => {
    const id = offeringIds.get(key)
    if (!id) throw new Error(`offering ${key} does not exist in RevenueCat`)
    return id
  }
  const packageId = (offeringKey: string, key: string) => {
    const id = packageIds.get(`${offeringKey}/${key}`)
    if (!id) throw new Error(`package ${key} does not exist in offering ${offeringKey}`)
    return id
  }

  return {
    store: 'revenuecat',
    label: `RevenueCat offerings (${t.projectId})`,

    async observe(desired) {
      const empty: RcOfferingsObserved = { projectId: t.projectId, apps: {}, offerings: [], packages: {} }
      if (!desired.length) return empty

      const found: RcOfferingsObserved['apps'] = {}
      const missing: string[] = []
      const list = await all(`${project}/apps`, app)
      if (t.bundleId) {
        const a = list.find((x) => x.type === 'app_store' && x.app_store?.bundle_id === t.bundleId)
        if (a) found.apple = a.id
        else missing.push(`the App Store app ${t.bundleId}`)
      }
      if (t.packageName) {
        const a = list.find((x) => x.type === 'play_store' && x.play_store?.package_name === t.packageName)
        if (a) found.play = a.id
        else missing.push(`the Play Store app ${t.packageName}`)
      }
      if (t.testStore) {
        // A missing Test Store app is reported by the products part; packages just skip it.
        const a = list.find((x) => x.type === 'test_store')
        if (a) found.test = a.id
      }
      if (missing.length) {
        throw new KitError(
          `RevenueCat project ${t.projectId} is missing ${missing.join(' and ')}`,
          'Connect the store apps in RevenueCat first (Project settings → Apps)',
          ExitCode.precondition,
        )
      }
      apps = found

      const offerings = await all(`${project}/offerings`, offering)
      for (const o of offerings) offeringIds.set(o.lookup_key, o.id)
      const wanted = new Set(desired.map((d) => d.lookupKey))
      const packages: RcOfferingsObserved['packages'] = {}
      for (const o of offerings.filter((x) => wanted.has(x.lookup_key))) {
        const items = await all(`${project}/offerings/${o.id}/packages`, pkg)
        packages[o.lookup_key] = []
        for (const p of items) {
          packageIds.set(`${o.lookup_key}/${p.lookup_key}`, p.id)
          const held = await all(`${project}/packages/${p.id}/products`, product)
          packages[o.lookup_key]!.push({ ...p, products: held })
        }
      }
      return { projectId: t.projectId, apps: found, offerings, packages }
    },

    diff: (desired, o, diffOpts) => diffRevenuecatOfferings(desired, o, t.products, diffOpts),

    async apply(action) {
      const p = action.payload as Record<string, unknown>
      switch (action.kind) {
        case ERROR_KIND:
          throw new Error(p.message as string)
        case 'offering': {
          const res = await client.request('POST', `${project}/offerings`, {
            body: { lookup_key: p.lookup_key, display_name: p.display_name },
            schema: offering,
          })
          offeringIds.set(res.lookup_key, res.id)
          return
        }
        case 'rename':
          await client.request('POST', `${project}/offerings/${offeringId(p.offering as string)}`, {
            body: { display_name: p.display_name },
            schema: anyJson,
          })
          return
        case 'current':
          await client.request('POST', `${project}/offerings/${offeringId(p.offering as string)}`, {
            body: { is_current: true },
            schema: anyJson,
          })
          return
        case 'package': {
          const key = p.offering as string
          const res = await client.request('POST', `${project}/offerings/${offeringId(key)}/packages`, {
            body: { lookup_key: p.lookup_key, display_name: p.display_name, position: p.position },
            schema: pkg,
          })
          packageIds.set(`${key}/${res.lookup_key}`, res.id)
          return
        }
        case 'package-update': {
          const { offering: o, package: k, ...body } = p
          await client.request('POST', `${project}/packages/${packageId(o as string, k as string)}`, {
            body,
            schema: anyJson,
          })
          return
        }
        case 'attach': {
          const target = packageId(p.offering as string, p.package as string)
          const file = t.products.find((x) => x.id === p.product)
          if (!file) throw new Error(`product ${p.product as string} is not in the file`)
          // The phase-1 product actions ran before this one: resolve RevenueCat ids now.
          const live = await all(`${project}/products`, product)
          const ids: string[] = []
          for (const store of p.stores as AppStore[]) {
            const storeId = file[store]
            const match = live.find((x) => x.app_id === apps[store] && x.store_identifier === storeId)
            if (!match) {
              throw new Error(
                `the ${STORE_WORD[store]} product ${storeId} does not exist in RevenueCat yet: create the RevenueCat products first (kit iap sync)`,
              )
            }
            if (ARCHIVED.has(match.state ?? '')) {
              throw new Error(
                `the ${STORE_WORD[store]} product ${storeId} is archived: unarchive it in RevenueCat`,
              )
            }
            ids.push(match.id)
          }
          await client
            .request('POST', `${project}/packages/${target}/actions/attach_products`, {
              body: { products: ids.map((product_id) => ({ product_id, eligibility_criteria: 'all' })) },
              schema: anyJson,
            })
            .catch(wrapArchived)
          return
        }
        default:
          throw new Error(`unknown RevenueCat offerings action ${action.kind}`)
      }
    },
  }
}
