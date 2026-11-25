import { type Json, json, type Req } from './common'

// Stateful RevenueCat v2 fake.

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
    {
      object: 'app',
      id: 'app_test',
      name: 'Test Store',
      type: 'test_store',
      project_id: 'projd2d1fc4a',
      app_store: null,
      play_store: null,
      test_store: null,
    },
  ]
  products = new Map<string, Json>()
  entitlements = new Map<string, Json>()
  attached = new Map<string, Set<string>>()
  offerings = new Map<string, Json>()
  /** Package id → package (with its `offering_id`). */
  packages = new Map<string, Json>()
  /** Package id → attached product ids. */
  packageProducts = new Map<string, Set<string>>()
  /** Set to make every Test Store product create fail with this message. */
  rejectTestCreate?: string
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

  seedOffering(lookupKey: string, over: Json = {}): string {
    const id = `ofrng${++this.seq}`
    this.offerings.set(id, {
      object: 'offering',
      id,
      lookup_key: lookupKey,
      display_name: lookupKey,
      is_current: false,
      state: 'active',
      project_id: this.projectId,
      created_at: 1,
      ...over,
    })
    return id
  }

  seedPackage(
    offeringId: string,
    lookupKey: string,
    position: number,
    products: string[] = [],
    over: Json = {},
  ): string {
    const id = `pkge${++this.seq}`
    this.packages.set(id, {
      object: 'package',
      id,
      offering_id: offeringId,
      lookup_key: lookupKey,
      display_name: lookupKey,
      position,
      state: 'active',
      created_at: 1,
      ...over,
    })
    this.packageProducts.set(id, new Set(products))
    return id
  }

  /** Offerings, packages and package attach (plan-4 §14). Returns undefined for other paths. */
  private handleOfferings(req: Req, p: string, body: Json, prefix: string): Response | undefined {
    let m: RegExpMatchArray | null
    const write = req.method === 'POST'
    if (req.method === 'GET' && p === 'offerings')
      return this.list([...this.offerings.values()], req, `${prefix}offerings`)
    if (write && p === 'offerings') {
      if (!body.lookup_key || !body.display_name)
        return this.error(400, 'parameter_error', 'lookup_key and display_name are required')
      if ('is_current' in body)
        return this.error(400, 'parameter_error', 'is_current cannot be set on create')
      if ([...this.offerings.values()].some((o) => o.lookup_key === body.lookup_key))
        return this.error(409, 'resource_already_exists', 'Offering already exists')
      const id = this.seedOffering(body.lookup_key as string, { display_name: body.display_name })
      return json(this.offerings.get(id), 201)
    }
    if (write && (m = p.match(/^offerings\/(\w+)$/))) {
      const o = this.offerings.get(m[1]!)
      if (!o) return this.error(404, 'resource_missing', 'Offering not found')
      for (const k of Object.keys(body)) {
        if (!['display_name', 'is_current', 'metadata'].includes(k))
          return this.error(400, 'parameter_error', `${k} cannot be updated`)
      }
      if (body.is_current === true) for (const x of this.offerings.values()) x.is_current = false
      Object.assign(o, body)
      return json(o)
    }
    if (req.method === 'GET' && (m = p.match(/^offerings\/(\w+)\/packages$/))) {
      if (!this.offerings.has(m[1]!)) return this.error(404, 'resource_missing', 'Offering not found')
      const items = [...this.packages.values()].filter((x) => x.offering_id === m![1])
      return this.list(items, req, `${prefix}offerings/${m[1]}/packages`)
    }
    if (write && (m = p.match(/^offerings\/(\w+)\/packages$/))) {
      if (!this.offerings.has(m[1]!)) return this.error(404, 'resource_missing', 'Offering not found')
      if (!body.lookup_key || !body.display_name || typeof body.position !== 'number')
        return this.error(400, 'parameter_error', 'lookup_key, display_name and position are required')
      const dup = [...this.packages.values()].some(
        (x) => x.offering_id === m![1] && x.lookup_key === body.lookup_key,
      )
      if (dup) return this.error(409, 'resource_already_exists', 'Package already exists')
      const id = this.seedPackage(m[1]!, body.lookup_key as string, body.position, [], {
        display_name: body.display_name,
      })
      return json(this.packages.get(id), 201)
    }
    if (write && (m = p.match(/^packages\/(\w+)$/))) {
      const pk = this.packages.get(m[1]!)
      if (!pk) return this.error(404, 'resource_missing', 'Package not found')
      for (const k of Object.keys(body)) {
        if (!['display_name', 'position'].includes(k))
          return this.error(400, 'parameter_error', `${k} cannot be updated`)
      }
      Object.assign(pk, body)
      return json(pk)
    }
    if (req.method === 'GET' && (m = p.match(/^packages\/(\w+)\/products$/))) {
      const set = this.packageProducts.get(m[1]!)
      if (!set) return this.error(404, 'resource_missing', 'Package not found')
      return this.list(
        [...set].map((id) => this.products.get(id)!),
        req,
        `${prefix}packages/${m[1]}/products`,
      )
    }
    if (write && (m = p.match(/^packages\/(\w+)\/actions\/attach_products$/))) {
      const set = this.packageProducts.get(m[1]!)
      if (!set) return this.error(404, 'resource_missing', 'Package not found')
      const items = body.products as { product_id: string; eligibility_criteria?: string }[] | undefined
      if (!items?.length) return this.error(400, 'parameter_error', 'products: at least one')
      const apps = new Set([...set].map((id) => this.products.get(id)!.app_id))
      for (const it of items) {
        const prod = this.products.get(it.product_id)
        if (!prod) return this.error(404, 'resource_missing', `Product ${it.product_id} not found`)
        if (prod.state === 'inactive')
          return this.error(422, 'entity_references_archived_entities', 'archived product')
        if (apps.has(prod.app_id))
          return this.error(422, 'invalid_request', 'package has a product for that app')
        apps.add(prod.app_id)
      }
      for (const it of items) set.add(it.product_id)
      return json(this.packages.get(m[1]!))
    }
    return undefined
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
      if (body.app_id === 'app_test') {
        if (!body.title)
          return this.error(400, 'parameter_error', 'title is required for Test Store products')
        const created = this.products.get(id)!
        created.title = body.title
        if (body.subscription) created.subscription = body.subscription
        if (this.rejectTestCreate) {
          this.products.delete(id)
          return this.error(422, 'invalid_request', this.rejectTestCreate)
        }
      }
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
    const offerings = this.handleOfferings(req, p, body, prefix)
    if (offerings) return offerings
    if (req.method === 'DELETE' || p.includes('detach') || p.includes('archive')) {
      return this.error(500, 'server_error', 'kit must never delete, detach or archive')
    }
    return this.error(404, 'resource_missing', `fake RC: no route ${req.method} ${p}`)
  }
}

// ---- server ---------------------------------------------------------------------------------------
