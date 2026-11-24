import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { KitConfig } from '../../config/schema'
import type { FileProduct, Iap, ProductFile } from './file'

/**
 * The product file resolved: defaults applied (entitlement, reference name, family sharing,
 * purchase option), then one desired shape per store.
 */

export interface Localized {
  name: string
  description: string
}

export interface CatalogProduct {
  id: string
  type: FileProduct['type']
  name: string
  description: string
  price: string
  priceChanges: { from: string; price: string }[]
  entitlement: string
  /** Default locale first, then the extras. */
  localizations: Record<string, Localized>
  apple: {
    referenceName: string
    reviewNote?: string
    /** Absolute path. */
    reviewScreenshot?: string
    familySharable: boolean
  }
  play: { purchaseOptionId: string }
}

export interface Catalog {
  locale: string
  products: CatalogProduct[]
  subscriptions: NonNullable<ProductFile['subscriptions']>
}

export function resolveCatalog(root: string, iap: Iap, file: ProductFile): Catalog {
  const abs = (p: string) => (isAbsolute(p) ? p : join(root, p))
  return {
    locale: file.locale,
    subscriptions: file.subscriptions ?? [],
    products: file.products.map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      description: p.description,
      price: p.price,
      priceChanges: p.priceChanges ?? [],
      entitlement: p.entitlement ?? p.id,
      localizations: { [file.locale]: { name: p.name, description: p.description }, ...p.localizations },
      apple: {
        referenceName: p.apple?.referenceName ?? p.name,
        reviewNote: p.apple?.reviewNote,
        reviewScreenshot: p.apple?.reviewScreenshot ? abs(p.apple.reviewScreenshot) : undefined,
        // Apple offers Family Sharing on non-consumables only.
        familySharable:
          p.type === 'non_consumable' && (p.apple?.familySharable ?? iap.apple?.familySharing ?? false),
      },
      play: { purchaseOptionId: p.play?.purchaseOptionId ?? 'buy' },
    })),
  }
}

/** Today's date (YYYY-MM-DD) in US Pacific time: App Store Connect evaluates price dates there. */
export function pacificToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Price in effect `today` and the changes still ahead (a change dated today or earlier is current). */
export function effectivePrices(
  p: Pick<CatalogProduct, 'price' | 'priceChanges'>,
  today: string,
): { current: string; scheduled: { from: string; price: string }[] } {
  let current = p.price
  const scheduled: { from: string; price: string }[] = []
  for (const c of [...p.priceChanges].sort((a, b) => a.from.localeCompare(b.from))) {
    if (c.from <= today) current = c.price
    else scheduled.push(c)
  }
  return { current, scheduled }
}

/** `4.99` and `4.990` and `4.99000` compare equal. */
export const samePrice = (a: string | number, b: string | number): boolean =>
  Math.round(Number(a) * 100) === Math.round(Number(b) * 100)

// ---- per store ------------------------------------------------------------------------------------

export interface AppleScreenshot {
  path: string
  fileName: string
  size: number
  md5: string
}

export interface AppleDesired {
  productId: string
  type: 'CONSUMABLE' | 'NON_CONSUMABLE'
  referenceName: string
  reviewNote?: string
  familySharable: boolean
  localizations: Record<string, Localized>
  price: string
  scheduled: { from: string; price: string }[]
  screenshot?: AppleScreenshot
}

export interface PlayDesired {
  productId: string
  purchaseOptionId: string
  listings: Record<string, { title: string; description: string }>
  price: string
  scheduled: { from: string; price: string }[]
}

export interface RcDesired {
  id: string
  type: 'non_consumable' | 'consumable'
  displayName: string
  entitlement: string
  /** Display name for a new entitlement: the first product's name that uses it. */
  entitlementName: string
  /** Store identifiers per app; a store missing here has no app in RevenueCat to attach. */
  apple?: string
  play?: string
}

function screenshot(path: string | undefined): AppleScreenshot | undefined {
  if (!path || !existsSync(path)) return undefined
  const bytes = readFileSync(path)
  return {
    path,
    fileName: basename(path),
    size: bytes.length,
    md5: createHash('md5').update(bytes).digest('hex'),
  }
}

export function appleDesired(catalog: Catalog, today: string): AppleDesired[] {
  return catalog.products.map((p) => {
    const prices = effectivePrices(p, today)
    return {
      productId: p.id,
      type: p.type === 'consumable' ? 'CONSUMABLE' : 'NON_CONSUMABLE',
      referenceName: p.apple.referenceName,
      reviewNote: p.apple.reviewNote,
      familySharable: p.apple.familySharable,
      localizations: p.localizations,
      price: prices.current,
      scheduled: prices.scheduled,
      screenshot: screenshot(p.apple.reviewScreenshot),
    }
  })
}

export function playDesired(catalog: Catalog, today: string): PlayDesired[] {
  return catalog.products.map((p) => {
    const prices = effectivePrices(p, today)
    return {
      productId: p.id,
      purchaseOptionId: p.play.purchaseOptionId,
      listings: Object.fromEntries(
        Object.entries(p.localizations).map(([l, v]) => [l, { title: v.name, description: v.description }]),
      ),
      price: prices.current,
      scheduled: prices.scheduled,
    }
  })
}

export function rcDesired(catalog: Catalog, stores: { apple: boolean; play: boolean }): RcDesired[] {
  const names = new Map<string, string>()
  for (const p of catalog.products) if (!names.has(p.entitlement)) names.set(p.entitlement, p.name)
  return catalog.products.map((p) => ({
    id: p.id,
    type: p.type,
    displayName: p.name,
    entitlement: p.entitlement,
    entitlementName: names.get(p.entitlement)!,
    apple: stores.apple ? p.id : undefined,
    play: stores.play ? p.id : undefined,
  }))
}

/** Which identifiers each store uses, from the config. */
export interface StoreTargets {
  apple?: { bundleId: string; familySharing: boolean }
  play?: { packageName: string }
  revenuecat?: { projectId: string; apiKeyEnv: string }
}

export function storeTargets(config: KitConfig, iap: Iap): StoreTargets {
  return {
    apple: iap.apple
      ? {
          bundleId: iap.apple.bundleId ?? config.release!.ios!.bundleIds[0]!,
          familySharing: iap.apple.familySharing,
        }
      : undefined,
    play: iap.play
      ? { packageName: iap.play.packageName ?? config.release!.android!.packageName }
      : undefined,
    revenuecat: iap.revenuecat,
  }
}
