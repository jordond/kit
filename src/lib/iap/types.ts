/** Shared shapes of `kit iap`: stores, status rows and planned actions (plan-4 §4). */

export const STORES = ['apple', 'play', 'revenuecat'] as const
export type Store = (typeof STORES)[number]

export const STORE_NAME: Record<Store, string> = {
  apple: 'App Store Connect',
  play: 'Google Play',
  revenuecat: 'RevenueCat',
}

export type SyncState = 'missing' | 'in-sync' | 'differs' | 'extra'

export interface StatusRow {
  store: Store
  /** File id (or the store's id for `extra`). */
  id: string
  sync: SyncState
  /** For `differs`: which fields. */
  fields?: string[]
  /** The store's own state (MISSING_METADATA, ACTIVE, DRAFT, attached …). */
  storeState?: string
  notes?: string[]
}

export interface Action<P = unknown> {
  store: Store
  /** File id the action belongs to; actions of one id run in order and stop at the first failure. */
  id: string
  kind: string
  /** One short phrase for the plan (`create`, `price 4.99`). */
  summary: string
  /** What apply needs; never printed. */
  payload?: P
}

export interface ActionResult {
  id: string
  kind: string
  ok: boolean
  /** Not run because an earlier action of the same id failed. */
  skipped?: boolean
  error?: string
}

export interface Diff<A extends Action = Action> {
  rows: StatusRow[]
  actions: A[]
}

export interface StoreAdapter<Desired, Observed, A extends Action = Action> {
  store: Store
  /** Heading for the plan and status (`App Store Connect (com.example)`). */
  label: string
  /** Reads only. Throws for store-level failures (bad creds, app not found). */
  observe(desired: Desired[]): Promise<Observed>
  /** Pure. `extras: false` (a `--product` filter) leaves out store products the run did not ask about. */
  diff(desired: Desired[], observed: Observed, opts?: { extras: boolean }): Diff<A>
  /** Optional read-only pass over the plan (Apple: resolve price points); may turn actions into errors. */
  prepare?(actions: A[], observed: Observed): Promise<A[]>
  apply(action: A): Promise<void>
}

/** An action that only fails: planned when the file asks for something the store cannot do. */
export const ERROR_KIND = 'error'

export function errorAction(store: Store, id: string, message: string): Action<{ message: string }> {
  return { store, id, kind: ERROR_KIND, summary: `error: ${message}`, payload: { message } }
}
