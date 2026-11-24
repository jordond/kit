import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'

/**
 * The product file (`iap.products`): one JSON file that is the source of truth for in-app products
 * in App Store Connect, Google Play and RevenueCat. The zod schema below is structural; the store
 * limits (lengths, id shapes, dates) are `check.ts` rules so they come back as one list of issues.
 * `schemas/iap.schema.json` is generated from it (`scripts/iap-schema.ts`).
 */

const price = z
  .string()
  .regex(/^\d+\.\d{2}$/, 'a USD price with two decimals, like "4.99"')
  .describe('USD price with two decimals, like "4.99"')

const localization = z
  .object({
    name: z.string().describe('Display name in this locale'),
    description: z.string().describe('Description in this locale'),
  })
  .strict()

const localizations = z
  .record(z.string(), localization)
  .describe('Extra locales (BCP-47, like "fr-FR"); the default locale comes from the top-level fields')

export const SUBSCRIPTION_PERIODS = ['P1W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y'] as const
export const TRIAL_PERIODS = ['P3D', 'P1W', 'P2W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y'] as const

const productSchema = z
  .object({
    id: z.string().describe('Product id in every console; permanent once created'),
    type: z.enum(['non_consumable', 'consumable']),
    name: z.string().describe('Apple display + reference name, Play title, RevenueCat display name'),
    description: z.string(),
    price,
    priceChanges: z
      .array(
        z
          .object({
            from: z.string().describe('ISO date (YYYY-MM-DD) the price takes effect'),
            price,
          })
          .strict(),
      )
      .optional()
      .describe('Scheduled price changes, oldest first'),
    entitlement: z.string().optional().describe('RevenueCat entitlement lookup key; default: id'),
    localizations: localizations.optional(),
    apple: z
      .object({
        referenceName: z.string().optional().describe('Default: name'),
        reviewNote: z.string().optional(),
        reviewScreenshot: z.string().optional().describe('Repo-relative PNG or JPEG for App Review'),
        familySharable: z.boolean().optional().describe('Default: iap.apple.familySharing'),
      })
      .strict()
      .optional(),
    play: z
      .object({
        purchaseOptionId: z.string().optional().describe('Default: "buy"'),
      })
      .strict()
      .optional(),
  })
  .strict()

const planSchema = z
  .object({
    id: z.string().describe('Play base plan id'),
    appleProductId: z.string().optional().describe('Default: `${subscription.id}_${plan.id}`, "-" → "_"'),
    period: z.enum(SUBSCRIPTION_PERIODS),
    price,
    trial: z.enum(TRIAL_PERIODS).optional().describe('Free trial length'),
  })
  .strict()

const subscriptionSchema = z
  .object({
    id: z.string().describe('Play subscription id; Apple group reference name'),
    name: z.string(),
    description: z.string(),
    benefits: z.array(z.string()).optional().describe('Play only: up to 4, 40 characters each'),
    entitlement: z.string().optional().describe('Default: id'),
    localizations: localizations.optional(),
    plans: z.array(planSchema).min(1).describe('First plan is the highest Apple group level'),
    apple: z
      .object({
        groupName: z.string().optional(),
        reviewNote: z.string().optional(),
        reviewScreenshot: z.string().optional(),
        familySharable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const packageSchema = z
  .object({
    id: z.string().describe('RevenueCat package lookup key, like "$rc_monthly" or "lifetime"'),
    name: z.string().optional().describe("Display name; default: the product's name"),
    product: z.string().describe('A product id, or "subscription:plan" for a subscription plan'),
  })
  .strict()

const offeringSchema = z
  .object({
    id: z.string().describe('RevenueCat offering lookup key; permanent once created'),
    name: z.string().optional().describe('Display name; default: id'),
    current: z.boolean().optional().describe('The current offering (at most one)'),
    packages: z.array(packageSchema).min(1).describe('In display order'),
  })
  .strict()

export const productFileSchema = z
  .object({
    $schema: z.string().optional(),
    locale: z.string().default('en-US').describe('Default locale: Apple localization and Play listing'),
    products: z.array(productSchema).default([]),
    subscriptions: z
      .array(subscriptionSchema)
      .optional()
      .describe('Auto-renewing subscriptions, one per Play subscription / Apple group'),
    offerings: z.array(offeringSchema).optional().describe('RevenueCat offerings and their packages'),
  })
  .strict()

export type ProductFile = z.output<typeof productFileSchema>
export type FileProduct = ProductFile['products'][number]
export type FileSubscription = NonNullable<ProductFile['subscriptions']>[number]
export type FileOffering = NonNullable<ProductFile['offerings']>[number]

export const SCHEMA_URL_PREFIX = 'https://cdn.jsdelivr.net/npm/@jordond/kit@'
export const schemaUrl = (version: string): string =>
  `${SCHEMA_URL_PREFIX}${version.split('.').slice(0, 2).join('.')}/schemas/iap.schema.json`

export type Iap = NonNullable<KitConfig['iap']>

/** The `iap` block, or exit 3 naming what to add. */
export function requireIap(config: KitConfig): Iap {
  if (!config.iap) {
    throw new KitError(
      'No `iap` in kit.config.ts',
      "Add `iap: { products: 'contract/products.json', apple: {}, play: {} }`; see docs/iap.md",
      ExitCode.config,
    )
  }
  return config.iap
}

export interface LoadedFile {
  /** Absolute path. */
  path: string
  /** Repo-relative, as configured. */
  label: string
  /** The raw JSON (for `$schema` and other checks that need what the user wrote). */
  raw: unknown
  /** Parsed and defaulted, or undefined when the file does not match the schema. */
  file?: ProductFile
  /** Schema errors as `path: message`. */
  errors: string[]
}

/** Read and parse the product file. A missing or non-JSON file throws (exit 3); a schema mismatch returns errors. */
export function readProductFile(root: string, iap: Iap): LoadedFile {
  const path = isAbsolute(iap.products) ? iap.products : join(root, iap.products)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new KitError(
      `${iap.products} not found`,
      'Create it (see docs/iap.md) or fix iap.products in kit.config.ts',
      ExitCode.config,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new KitError(
      `${iap.products} is not valid JSON: ${(e as Error).message}`,
      undefined,
      ExitCode.config,
    )
  }
  const parsed = productFileSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      path,
      label: iap.products,
      raw,
      errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
    }
  }
  return { path, label: iap.products, raw, file: parsed.data, errors: [] }
}

/** The published JSON schema (`schemas/iap.schema.json`), as text. */
export function iapJsonSchema(): string {
  const schema = z.toJSONSchema(productFileSchema, { io: 'input', target: 'draft-2020-12' })
  return `${JSON.stringify({ ...schema, title: 'kit in-app products', $id: undefined }, null, 2)}\n`
}
