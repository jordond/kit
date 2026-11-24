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
  ]
  products = new Map<string, Json>()
  entitlements = new Map<string, Json>()
  attached = new Map<string, Set<string>>()
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
    if (req.method === 'DELETE' || p.includes('detach') || p.includes('archive')) {
      return this.error(500, 'server_error', 'kit must never delete, detach or archive')
    }
    return this.error(404, 'resource_missing', `fake RC: no route ${req.method} ${p}`)
  }
}

// ---- server ---------------------------------------------------------------------------------------
