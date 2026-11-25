import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { KitConfig } from '../../config/schema'
import { appleProductId } from './check'
import type { FileProduct, Iap, ProductFile, SUBSCRIPTION_PERIODS, TRIAL_PERIODS } from './file'

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

export type Period = (typeof SUBSCRIPTION_PERIODS)[number]
export type TrialPeriod = (typeof TRIAL_PERIODS)[number]

export interface CatalogPlan {
  /** Play base plan id. */
  id: string
  appleProductId: string
  period: Period
  price: string
  trial?: TrialPeriod
}

export interface CatalogSubscription {
  id: string
  name: string
  description: string
  benefits: string[]
  entitlement: string
  /** Default locale first, then the extras. */
  localizations: Record<string, Localized>
  /** First = highest Apple group level. */
  plans: CatalogPlan[]
  apple: {
    groupName: string
    reviewNote?: string
    /** Absolute path. */
    reviewScreenshot?: string
    familySharable: boolean
  }
}

export interface CatalogPackage {
  id: string
  name: string
  /** A product id or `subscription:plan`: the `RcDesired.id` it points at. */
  product: string
}

export interface CatalogOffering {
  id: string
  name: string
  current: boolean
  packages: CatalogPackage[]
}

export interface Catalog {
  locale: string
  products: CatalogProduct[]
  subscriptions: CatalogSubscription[]
  offerings: CatalogOffering[]
}

/** The RevenueCat / file reference of a subscription plan: `pro:monthly` (also Play's RC store identifier). */
export const planRef = (subId: string, planId: string): string => `${subId}:${planId}`

export function resolveCatalog(root: string, iap: Iap, file: ProductFile): Catalog {
  const abs = (p: string) => (isAbsolute(p) ? p : join(root, p))
  const catalog: Catalog = {
    locale: file.locale,
    subscriptions: (file.subscriptions ?? []).map((sub) => ({
      id: sub.id,
      name: sub.name,
      description: sub.description,
      benefits: sub.benefits ?? [],
      entitlement: sub.entitlement ?? sub.id,
      localizations: {
        [file.locale]: { name: sub.name, description: sub.description },
        ...sub.localizations,
      },
      plans: sub.plans.map((plan) => ({
        id: plan.id,
        appleProductId: appleProductId(sub.id, plan),
        period: plan.period,
        price: plan.price,
        trial: plan.trial,
      })),
      apple: {
        groupName: sub.apple?.groupName ?? sub.name,
        reviewNote: sub.apple?.reviewNote,
        reviewScreenshot: sub.apple?.reviewScreenshot ? abs(sub.apple.reviewScreenshot) : undefined,
        familySharable: sub.apple?.familySharable ?? iap.apple?.familySharing ?? false,
      },
    })),
    offerings: [],
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
  const names = new Map<string, string>(catalog.products.map((p) => [p.id, p.name]))
  for (const sub of catalog.subscriptions)
    for (const plan of sub.plans) names.set(planRef(sub.id, plan.id), sub.name)
  catalog.offerings = (file.offerings ?? []).map((o) => ({
    id: o.id,
    name: o.name ?? o.id,
    current: o.current ?? false,
    packages: o.packages.map((pk) => ({
      id: pk.id,
      name: pk.name ?? names.get(pk.product) ?? pk.id,
      product: pk.product,
    })),
  }))
  return catalog
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
  type: 'non_consumable' | 'consumable' | 'subscription'
  displayName: string
  entitlement: string
  /** Display name for a new entitlement: the first product's name that uses it. */
  entitlementName: string
  /** Store identifiers per app; a store missing here has no app in RevenueCat to attach. */
  apple?: string
  play?: string
  /** Test Store identifier (opt-in); `testTitle` and `testDuration` are what its create needs. */
  test?: string
  testTitle?: string
  /** Subscriptions only: the Test Store `subscription.duration`. */
  testDuration?: string
  /** Set instead of `test` when the plan cannot exist in the Test Store. */
  testError?: string
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

/**
 * One RevenueCat product pair per one-time product and per subscription plan. Plans are
 * `subscription:plan` (Play's RC store identifier), named after the subscription and the period.
 */
export function rcDesired(
  catalog: Catalog,
  stores: { apple: boolean; play: boolean; test?: boolean },
): RcDesired[] {
  const names = new Map<string, string>()
  for (const p of catalog.products) if (!names.has(p.entitlement)) names.set(p.entitlement, p.name)
  for (const s of catalog.subscriptions) if (!names.has(s.entitlement)) names.set(s.entitlement, s.name)
  const products: RcDesired[] = catalog.products.map((p) => ({
    id: p.id,
    type: p.type,
    displayName: p.name,
    entitlement: p.entitlement,
    entitlementName: names.get(p.entitlement)!,
    apple: stores.apple ? p.id : undefined,
    play: stores.play ? p.id : undefined,
    ...(stores.test ? { test: p.id, testTitle: p.localizations[catalog.locale]?.name ?? p.name } : {}),
  }))
  const plans: RcDesired[] = catalog.subscriptions.flatMap((s) =>
    s.plans.map((plan) => ({
      id: planRef(s.id, plan.id),
      type: 'subscription' as const,
      displayName: `${s.name} (${PERIOD_LABEL[plan.period]})`,
      entitlement: s.entitlement,
      entitlementName: names.get(s.entitlement)!,
      apple: stores.apple ? plan.appleProductId : undefined,
      play: stores.play ? planRef(s.id, plan.id) : undefined,
      ...(stores.test ? testStorePlan(`${s.name} (${PERIOD_LABEL[plan.period]})`, plan) : {}),
    })),
  )
  return [...products, ...plans]
}

/** RevenueCat Test Store `subscription.duration` values; a period missing here has no Test Store product. */
export const TEST_STORE_DURATION: Partial<Record<Period, string>> = {
  P1W: 'P1W',
  P1M: 'P1M',
  P2M: 'P2M',
  P3M: 'P3M',
  P6M: 'P6M',
  P1Y: 'P1Y',
}

function testStorePlan(title: string, plan: CatalogPlan): Partial<RcDesired> {
  const duration = TEST_STORE_DURATION[plan.period]
  if (!duration) {
    return {
      testError: `the Test Store has no subscription duration for ${plan.period} (it takes ${Object.keys(TEST_STORE_DURATION).join(', ')})`,
    }
  }
  return { test: plan.appleProductId, testTitle: title, testDuration: duration }
}

const PERIOD_LABEL: Record<Period, string> = {
  P1W: 'weekly',
  P1M: 'monthly',
  P2M: 'every 2 months',
  P3M: 'every 3 months',
  P6M: 'every 6 months',
  P1Y: 'yearly',
}

export interface RcOfferingDesired {
  lookupKey: string
  displayName: string
  current: boolean
  /** Position is the index + 1. */
  packages: { lookupKey: string; displayName: string; position: number; product: string }[]
}

export function rcOfferingsDesired(catalog: Catalog): RcOfferingDesired[] {
  return catalog.offerings.map((o) => ({
    lookupKey: o.id,
    displayName: o.name,
    current: o.current,
    packages: o.packages.map((p, i) => ({
      lookupKey: p.id,
      displayName: p.name,
      position: i + 1,
      product: p.product,
    })),
  }))
}

// ---- subscriptions per store ---------------------------------------------------------------------

/** App Store Connect `subscriptionPeriod`. */
export const APPLE_PERIOD: Record<Period, string> = {
  P1W: 'ONE_WEEK',
  P1M: 'ONE_MONTH',
  P2M: 'TWO_MONTHS',
  P3M: 'THREE_MONTHS',
  P6M: 'SIX_MONTHS',
  P1Y: 'ONE_YEAR',
}

/** App Store Connect introductory offer `duration` of a FREE_TRIAL (numberOfPeriods 1). */
export const APPLE_TRIAL: Record<TrialPeriod, string> = {
  P3D: 'THREE_DAYS',
  P1W: 'ONE_WEEK',
  P2W: 'TWO_WEEKS',
  P1M: 'ONE_MONTH',
  P2M: 'TWO_MONTHS',
  P3M: 'THREE_MONTHS',
  P6M: 'SIX_MONTHS',
  P1Y: 'ONE_YEAR',
}

export interface AppleSubscriptionPlanDesired {
  /** File plan ref (`pro:monthly`), for rows and actions. */
  ref: string
  productId: string
  /** Reference name: `Pro (monthly)`. */
  name: string
  period: string
  /** 1 = highest service level in the group. */
  groupLevel: number
  price: string
  /** Introductory FREE_TRIAL duration. */
  trial?: string
  familySharable: boolean
  reviewNote?: string
  localizations: Record<string, Localized>
  screenshot?: AppleScreenshot
}

/** One Apple subscription group per file subscription, one subscription per plan. */
export interface AppleSubscriptionDesired {
  /** File subscription id; also the group's reference name. */
  id: string
  /** Group display name per locale (the default locale gets `apple.groupName`). */
  groupLocalizations: Record<string, string>
  plans: AppleSubscriptionPlanDesired[]
}

export function appleSubscriptionsDesired(catalog: Catalog): AppleSubscriptionDesired[] {
  return catalog.subscriptions.map((s) => ({
    id: s.id,
    groupLocalizations: { [catalog.locale]: s.apple.groupName },
    plans: s.plans.map((plan, i) => ({
      ref: planRef(s.id, plan.id),
      productId: plan.appleProductId,
      name: `${s.name} (${PERIOD_LABEL[plan.period]})`,
      period: APPLE_PERIOD[plan.period],
      groupLevel: i + 1,
      price: plan.price,
      trial: plan.trial ? APPLE_TRIAL[plan.trial] : undefined,
      familySharable: s.apple.familySharable,
      reviewNote: s.apple.reviewNote,
      localizations: s.localizations,
      screenshot: screenshot(s.apple.reviewScreenshot),
    })),
  }))
}

export interface PlayBasePlanDesired {
  basePlanId: string
  /** ISO 8601 `billingPeriodDuration`. */
  period: Period
  price: string
  /** ISO 8601 free-trial duration of the `free-trial` offer. */
  trial?: TrialPeriod
  /** True on the first plan only: what RevenueCat and older billing libraries read. */
  legacyCompatible: boolean
}

export interface PlaySubscriptionDesired {
  productId: string
  listings: Record<string, { title: string; description: string; benefits: string[] }>
  basePlans: PlayBasePlanDesired[]
}

export function playSubscriptionsDesired(catalog: Catalog): PlaySubscriptionDesired[] {
  return catalog.subscriptions.map((s) => ({
    productId: s.id,
    listings: Object.fromEntries(
      Object.entries(s.localizations).map(([l, v]) => [
        l,
        // Benefits are written once in the file; every listing gets them.
        { title: v.name, description: v.description, benefits: s.benefits },
      ]),
    ),
    basePlans: s.plans.map((plan, i) => ({
      basePlanId: plan.id,
      period: plan.period,
      price: plan.price,
      trial: plan.trial,
      legacyCompatible: i === 0,
    })),
  }))
}

/** Which identifiers each store uses, from the config. */
export interface StoreTargets {
  apple?: { bundleId: string; familySharing: boolean }
  play?: { packageName: string }
  revenuecat?: { projectId: string; apiKeyEnv: string; testStore?: boolean }
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
