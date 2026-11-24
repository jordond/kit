import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { type Client, StoreError } from './http'

/**
 * App Store review screenshots, shared by in-app purchases and subscriptions: reserve, upload the
 * parts to the pre-signed URLs, commit with the checksum, wait for processing (plan-4 §5 Apple).
 */

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

const KINDS = {
  inAppPurchase: {
    type: 'inAppPurchaseAppStoreReviewScreenshots',
    owner: 'inAppPurchaseV2',
    ownerType: 'inAppPurchases',
  },
  subscription: {
    type: 'subscriptionAppStoreReviewScreenshots',
    owner: 'subscription',
    ownerType: 'subscriptions',
  },
} as const

export async function uploadReviewScreenshot(
  client: Client,
  kind: keyof typeof KINDS,
  ownerId: string,
  shot: { path: string; fileName: string; size: number; md5: string },
  opts: { sleep: (ms: number) => Promise<void>; pollMs?: number; pollLimitMs?: number },
): Promise<void> {
  const k = KINDS[kind]
  const reserved = await client.request('POST', `v1/${k.type}`, {
    body: {
      data: {
        type: k.type,
        attributes: { fileName: shot.fileName, fileSize: shot.size },
        relationships: { [k.owner]: { data: { type: k.ownerType, id: ownerId } } },
      },
    },
    schema: screenshotResponse,
  })
  const sid = reserved.data.id
  const bytes = readFileSync(shot.path)
  for (const op of reserved.data.attributes?.uploadOperations ?? []) {
    // Upload URLs are pre-signed: no App Store Connect token.
    const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]))
    const res = await fetch(op.url, {
      method: op.method,
      headers,
      body: bytes.subarray(op.offset, op.offset + op.length),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      throw new StoreError(
        'apple',
        res.status,
        undefined,
        `screenshot upload: ${(await res.text()).slice(0, 200)}`,
      )
    }
  }
  await client.request('PATCH', `v1/${k.type}/${sid}`, {
    body: { data: { type: k.type, id: sid, attributes: { uploaded: true, sourceFileChecksum: shot.md5 } } },
    schema: z.unknown(),
  })
  const limit = opts.pollLimitMs ?? 60_000
  const every = opts.pollMs ?? 2000
  for (let waited = 0; ; waited += every) {
    const s = await client.request('GET', `v1/${k.type}/${sid}`, { schema: screenshotResponse })
    const state = s.data.attributes?.assetDeliveryState?.state
    if (state === 'COMPLETE') return
    if (state === 'FAILED') {
      const why = s.data.attributes?.assetDeliveryState?.errors?.map((e) => e.description).join('; ')
      throw new Error(`App Store Connect could not process the review screenshot${why ? `: ${why}` : ''}`)
    }
    if (waited >= limit) {
      throw new Error(
        `the review screenshot is still ${state ?? 'processing'} after ${limit / 1000} s; run status later`,
      )
    }
    await opts.sleep(every)
  }
}
/**
 * Why an observed review screenshot is not the file's, or undefined when it is. Only a COMPLETE
 * upload counts: one reserved but never uploaded (AWAITING_UPLOAD) has no checksum and would
 * otherwise pass on name and size alone. kit never deletes, so every case is a note.
 */
export function reviewScreenshotProblem(
  s: { checksum?: string | null; fileSize?: number | null; fileName?: string | null; state?: string | null },
  want: { md5: string; size: number; fileName: string },
): string | undefined {
  if (s.state === 'FAILED')
    return 'the review screenshot upload FAILED: delete it in App Store Connect, then sync again'
  if (s.state === 'AWAITING_UPLOAD' || (s.state && s.state !== 'COMPLETE' && s.state !== 'UPLOAD_COMPLETE')) {
    return `the review screenshot is ${s.state}: its upload never finished; delete it in App Store Connect, then sync again`
  }
  if (s.state === 'UPLOAD_COMPLETE')
    return 'the review screenshot is still processing: check status again shortly'
  const same = s.checksum
    ? s.checksum.toLowerCase() === want.md5
    : s.fileSize === want.size && s.fileName === want.fileName
  return same
    ? undefined
    : 'the review screenshot differs: kit never deletes, so replace it in App Store Connect (or delete it there and sync again)'
}
