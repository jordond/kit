import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { imageInfo } from '../image/png'
import { SCHEMA_URL_PREFIX, type ProductFile, schemaUrl } from './file'

/**
 * Offline rules over the product file (plan-4 §3 `check` rules). Pure apart from reading the
 * review screenshots. Limits are the App Store Connect Help and Play reference values; where a
 * store accepts more, the stricter one wins so a file that passes works in both.
 */

export interface Issue {
  level: 'error' | 'warn'
  /** `products[2].name`, `subscriptions[0].plans[1].id`. */
  path: string
  message: string
}

export const LIMITS = {
  productId: 100,
  subscriptionId: 40,
  playOptionId: 63,
  appleId: 100,
  appleNameMin: 2,
  appleName: 30,
  appleReferenceName: 64,
  playTitle: 55,
  appleDescription: 45,
  playDescription: 200,
  playSubscriptionDescription: 80,
  reviewNote: 4000,
  benefits: 4,
  benefit: 40,
} as const

const PRODUCT_ID = /^[a-z0-9][a-z0-9_.]*$/
const PLAY_OPTION_ID = /^[a-z0-9][a-z0-9-]*$/
const APPLE_ID = /^[A-Za-z0-9._-]+$/
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Length in code points, as the stores count characters (an emoji is one). */
const chars = (s: string): number => Array.from(s).length

/** A real calendar day as YYYY-MM-DD (2027-02-30 is not). */
function isDate(s: string): boolean {
  if (!DATE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Apple product id of a subscription plan: `appleProductId`, else `${sub}_${plan}` with '-' → '_'. */
export const appleProductId = (subId: string, plan: { id: string; appleProductId?: string }): string =>
  plan.appleProductId ?? `${subId}_${plan.id}`.replaceAll('-', '_')

export interface CheckOptions {
  root: string
  /** `YYYY-MM-DD`, US Pacific. */
  today: string
  /** The running kit's version, for the `$schema` URL. */
  version: string
  /** The raw JSON, for `$schema`. */
  raw: unknown
}

export function checkProductFile(file: ProductFile, opts: CheckOptions): Issue[] {
  const issues: Issue[] = []
  const error = (path: string, message: string) => issues.push({ level: 'error', path, message })
  const warn = (path: string, message: string) => issues.push({ level: 'warn', path, message })
  const max = (path: string, value: string | undefined, limit: number, what: string) => {
    if (value !== undefined && chars(value) > limit) {
      error(path, `${what} is ${chars(value)} characters; the limit is ${limit}`)
    }
  }

  // $schema: editors validate with it; a stale one validates against an older format.
  const declared = (opts.raw as { $schema?: unknown } | null)?.$schema
  const expected = schemaUrl(opts.version)
  if (typeof declared !== 'string') warn('$schema', `missing; set it to ${expected}`)
  else if (declared.startsWith(SCHEMA_URL_PREFIX) && declared !== expected) {
    warn('$schema', `names another kit version; set it to ${expected}`)
  }

  if (!LOCALE.test(file.locale)) error('locale', `"${file.locale}" is not a BCP-47 locale like en-US`)

  // Ids: every id a store sees, so one id never names two things.
  const owners = new Map<string, string>()
  const claim = (id: string, path: string) => {
    const prev = owners.get(id)
    if (prev) error(path, `id "${id}" is already used by ${prev}`)
    else owners.set(id, path)
  }

  const localized = (
    base: string,
    locs: Record<string, { name: string; description: string }> | undefined,
    descriptionLimit: number,
  ) => {
    for (const [locale, l] of Object.entries(locs ?? {})) {
      const at = `${base}.localizations.${locale}`
      if (!LOCALE.test(locale)) error(at, `"${locale}" is not a BCP-47 locale like fr-FR`)
      if (locale === file.locale)
        error(at, `${locale} is the default locale; set it with the top-level fields`)
      names(at, l.name)
      descriptions(at, l.description, descriptionLimit)
    }
  }
  const names = (at: string, name: string) => {
    const n = chars(name)
    if (n < LIMITS.appleNameMin)
      error(`${at}.name`, `name must be at least ${LIMITS.appleNameMin} characters (Apple)`)
    // Apple's 30 is the tighter of Apple's display name and Play's title (55).
    max(`${at}.name`, name, Math.min(LIMITS.appleName, LIMITS.playTitle), 'name')
  }
  const descriptions = (at: string, description: string, playLimit: number) => {
    // Apple's 45 is tighter than Play's (200 one-time, 80 subscription).
    max(`${at}.description`, description, Math.min(LIMITS.appleDescription, playLimit), 'description')
  }
  const reviewNote = (at: string, note: string | undefined) =>
    max(`${at}.apple.reviewNote`, note, LIMITS.reviewNote, 'reviewNote')
  const screenshot = (at: string, file: string | undefined) => {
    if (file === undefined) return
    const path = isAbsolute(file) ? file : join(opts.root, file)
    if (!existsSync(path)) {
      error(`${at}.apple.reviewScreenshot`, `${file} not found`)
      return
    }
    try {
      const info = imageInfo(readFileSync(path))
      if (info.alpha)
        error(`${at}.apple.reviewScreenshot`, `${file} has an alpha channel; App Store Connect refuses it`)
    } catch (e) {
      error(`${at}.apple.reviewScreenshot`, `${file}: ${(e as Error).message}`)
    }
  }
  const price = (at: string, value: string) => {
    if (Number(value) <= 0) error(at, 'price must be more than 0')
  }

  const lastScheduleDay = `${Number(opts.today.slice(0, 4)) + 1}-12-31`

  for (const [i, p] of file.products.entries()) {
    const at = `products[${i}]`
    if (!PRODUCT_ID.test(p.id)) {
      error(`${at}.id`, `"${p.id}" must start with a lowercase letter or digit and hold only a-z 0-9 _ .`)
    }
    max(`${at}.id`, p.id, LIMITS.productId, 'id')
    claim(p.id, at)
    names(at, p.name)
    max(
      `${at}.apple.referenceName`,
      p.apple?.referenceName ?? p.name,
      LIMITS.appleReferenceName,
      'reference name',
    )
    descriptions(at, p.description, LIMITS.playDescription)
    localized(at, p.localizations, LIMITS.playDescription)
    reviewNote(at, p.apple?.reviewNote)
    screenshot(at, p.apple?.reviewScreenshot)
    price(`${at}.price`, p.price)
    if (p.type === 'consumable' && p.apple?.familySharable) {
      error(`${at}.apple.familySharable`, 'Apple offers Family Sharing on non-consumables only')
    }
    const option = p.play?.purchaseOptionId
    if (option !== undefined) {
      if (!PLAY_OPTION_ID.test(option)) {
        error(`${at}.play.purchaseOptionId`, `"${option}" must start with a-z or 0-9 and hold only a-z 0-9 -`)
      }
      max(`${at}.play.purchaseOptionId`, option, LIMITS.playOptionId, 'purchaseOptionId')
    }
    let previous = ''
    for (const [j, c] of (p.priceChanges ?? []).entries()) {
      const cat = `${at}.priceChanges[${j}]`
      price(`${cat}.price`, c.price)
      if (!isDate(c.from)) {
        error(`${cat}.from`, `"${c.from}" is not a date (YYYY-MM-DD)`)
        continue
      }
      if (previous && c.from <= previous) error(`${cat}.from`, `${c.from} is not after ${previous}`)
      previous = c.from
      if (c.from <= opts.today) {
        warn(`${cat}.from`, `${c.from} has passed: ${c.price} is the current price; move it into "price"`)
      }
      if (c.from > lastScheduleDay) {
        error(
          `${cat}.from`,
          `${c.from} is after ${lastScheduleDay}; Apple schedules up to the end of next year`,
        )
      }
    }
  }

  for (const [i, s] of (file.subscriptions ?? []).entries()) {
    const at = `subscriptions[${i}]`
    if (!PRODUCT_ID.test(s.id)) {
      error(`${at}.id`, `"${s.id}" must start with a lowercase letter or digit and hold only a-z 0-9 _ .`)
    }
    max(`${at}.id`, s.id, LIMITS.subscriptionId, 'subscription id')
    claim(s.id, at)
    names(at, s.name)
    descriptions(at, s.description, LIMITS.playSubscriptionDescription)
    localized(at, s.localizations, LIMITS.playSubscriptionDescription)
    reviewNote(at, s.apple?.reviewNote)
    screenshot(at, s.apple?.reviewScreenshot)
    if ((s.benefits ?? []).length > LIMITS.benefits)
      error(`${at}.benefits`, `at most ${LIMITS.benefits} benefits`)
    for (const [j, b] of (s.benefits ?? []).entries())
      max(`${at}.benefits[${j}]`, b, LIMITS.benefit, 'benefit')
    const plans = new Set<string>()
    for (const [j, plan] of s.plans.entries()) {
      const pat = `${at}.plans[${j}]`
      if (!PLAY_OPTION_ID.test(plan.id)) {
        error(`${pat}.id`, `"${plan.id}" must start with a-z or 0-9 and hold only a-z 0-9 -`)
      }
      max(`${pat}.id`, plan.id, LIMITS.playOptionId, 'plan id')
      if (plans.has(plan.id)) error(`${pat}.id`, `plan "${plan.id}" appears twice`)
      plans.add(plan.id)
      const apple = appleProductId(s.id, plan)
      if (!APPLE_ID.test(apple)) error(`${pat}.appleProductId`, `"${apple}" may hold only A-Z a-z 0-9 . _ -`)
      max(`${pat}.appleProductId`, apple, LIMITS.appleId, 'Apple product id')
      claim(apple, `${pat} (Apple product id)`)
      price(`${pat}.price`, plan.price)
    }
  }
  return issues
}
