import { StoreError } from './http'

/** Shared by the Play one-time and subscription adapters. */

const PRECONDITION =
  /billing|merchant|payment|payments profile|publish|apk|bundle|not allowed to create|has no (app|apk)/i

/** A Play 4xx whose own message reads like a missing payments profile or billing-enabled build. */
export function isBillingPrecondition(e: unknown): boolean {
  return e instanceof StoreError && e.status < 500 && PRECONDITION.test(e.detail)
}

/** Runs a Play write; a billing-precondition refusal gets the manual step as a hint. */
export async function withBillingHint<T>(
  what: 'products' | 'subscriptions',
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (isBillingPrecondition(e)) {
      throw new Error(
        `${(e as StoreError).message}. Play needs a payments profile and an app bundle that declares com.android.vending.BILLING on a track (kit release android --track internal) before ${what}`,
      )
    }
    throw e
  }
}

/** Strip `state` (output-only in Play) before sending an observed object back. */
export function withoutState<T extends { state?: unknown }>(o: T): Omit<T, 'state'> {
  const { state: _state, ...rest } = o
  return rest
}
