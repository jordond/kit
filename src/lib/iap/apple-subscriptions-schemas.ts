import { z } from 'zod'

/** Response shapes of the App Store Connect subscriptions adapter (JSON:API, parsed on every read). */

export const ref = z.object({ type: z.string(), id: z.string() })
export const toOne = z.object({ data: ref.nullable().optional() }).optional()
export const toMany = z.object({ data: z.array(ref).optional() }).optional()
export const links = z.object({ next: z.string().nullish() }).optional()
export const resource = z.object({
  type: z.string(),
  id: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
})
export const appsResponse = z.object({
  data: z.array(z.object({ id: z.string(), attributes: z.object({ bundleId: z.string() }) })),
})
export const groupList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({ referenceName: z.string() }),
      relationships: z.object({ versions: toMany }).optional(),
    }),
  ),
  included: z.array(resource).optional(),
  links,
})
export const subList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({
        name: z.string(),
        productId: z.string(),
        subscriptionPeriod: z.string().nullish(),
        groupLevel: z.number().nullish(),
        familySharable: z.boolean().nullish(),
        reviewNote: z.string().nullish(),
        state: z.string().nullish(),
      }),
      relationships: z.object({ versions: toMany, appStoreReviewScreenshot: toOne }).optional(),
    }),
  ),
  included: z.array(resource).optional(),
  links,
})
export const versionsResponse = z.object({
  data: z.array(z.object({ id: z.string(), attributes: z.object({ state: z.string().nullish() }) })),
  links,
})
export const localizationsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({
        locale: z.string(),
        name: z.string().nullish(),
        description: z.string().nullish(),
      }),
    }),
  ),
  links,
})
export const pricesResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z
        .object({
          startDate: z.string().nullish(),
          endDate: z.string().nullish(),
          preserved: z.boolean().nullish(),
        })
        .optional(),
      relationships: z.object({ subscriptionPricePoint: toOne }).optional(),
    }),
  ),
  included: z.array(resource).optional(),
  links,
})
export const pricePointsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({ customerPrice: z.string() }),
      relationships: z.object({ territory: toOne }).optional(),
    }),
  ),
  links,
})
export const territoriesResponse = z.object({ data: z.array(z.object({ id: z.string() })), links })
export const planAvailabilities = z.object({ data: z.array(z.object({ id: z.string() })) })
export const legacyAvailability = z.object({ data: z.object({ id: z.string() }).nullish() })
export const offersResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({
        duration: z.string(),
        offerMode: z.string(),
        endDate: z.string().nullish(),
      }),
      relationships: z.object({ territory: toOne }).optional(),
    }),
  ),
  links,
})
export const created = z.object({ data: z.object({ id: z.string() }) })
export const anyJson = z.unknown()
export const screenshotResponse = z.object({
  data: z.object({
    id: z.string(),
    attributes: z
      .object({
        uploadOperations: z
          .array(
            z.object({
              method: z.string(),
              url: z.string(),
              offset: z.number(),
              length: z.number(),
              requestHeaders: z.array(z.object({ name: z.string(), value: z.string() })).nullish(),
            }),
          )
          .nullish(),
        assetDeliveryState: z
          .object({
            state: z.string(),
            errors: z.array(z.object({ description: z.string().nullish() })).nullish(),
          })
          .nullish(),
      })
      .optional(),
  }),
})
