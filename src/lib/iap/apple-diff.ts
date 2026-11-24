import { reviewScreenshotProblem as screenshotProblem } from './apple-screenshot'
import { type AppleDesired, samePrice } from './model'
import { type Action, type Diff, errorAction, type StatusRow } from './types'

/** The pure half of the App Store Connect one-time adapter: observed shapes and the diff (plan-4 §5 Apple). */

export { screenshotProblem }
// ---- observed -------------------------------------------------------------------------------------

export interface AppleIap {
  ascId: string
  productId: string
  type: string
  referenceName: string
  reviewNote?: string
  familySharable: boolean
  state?: string
  /** The version kit reads localizations from: the draft, else the latest. */
  version?: { id: string; state?: string }
  hasDraft: boolean
  localizations: { id: string; locale: string; name: string; description: string }[]
  scheduleId?: string
  /** USA manual prices. */
  prices: { startDate: string | null; endDate: string | null; customerPrice: string; preserved?: boolean }[]
  availability: boolean
  screenshot?: { id: string; checksum?: string; fileName?: string; fileSize?: number; state?: string }
}

export interface AppleObserved {
  appId: string
  bundleId: string
  today: string
  iaps: AppleIap[]
}

const TYPE_WORD: Record<string, string> = {
  NON_CONSUMABLE: 'non-consumable',
  CONSUMABLE: 'consumable',
  NON_RENEWING_SUBSCRIPTION: 'non-renewing subscription',
}

export const DRAFT = 'PREPARE_FOR_SUBMISSION'

/** Price in effect `today` and the dated ones after it, from the USA manual prices. */

export function observedPrices(
  prices: AppleIap['prices'],
  today: string,
): { current?: string; inEffect: string[]; scheduled: { from: string; price: string }[] } {
  let current: { start: string; price: string } | undefined
  const scheduled: { from: string; price: string }[] = []
  let tied: string[] = []
  for (const p of prices) {
    if (p.endDate && p.endDate <= today) continue
    const start = p.startDate ?? ''
    if (p.startDate && p.startDate > today) scheduled.push({ from: p.startDate, price: p.customerPrice })
    else if (!current || start > current.start) {
      current = { start, price: p.customerPrice }
      tied = [p.customerPrice]
    } else if (start === current.start) {
      tied.push(p.customerPrice)
      // Ties (an old price kept for subscribers next to the new one, both in effect): prefer the
      // one not marked preserved; which of the two Apple marks is unverified, so `inEffect` keeps both.
      if (!p.preserved) current = { start, price: p.customerPrice }
    }
  }
  scheduled.sort((a, b) => a.from.localeCompare(b.from))
  return { current: current?.price, inEffect: tied, scheduled }
}

// ---- actions --------------------------------------------------------------------------------------

export type AppleAction =
  | Action<{ message: string }>
  | Action<{ attributes: Record<string, unknown> }>
  | Action<{ locales: Record<string, { name: string; description: string }> }>
  | Action<{ price: string; scheduled: { from: string; price: string }[]; points?: Record<string, string> }>
  | Action<{ screenshot: NonNullable<AppleDesired['screenshot']> }>
  | Action

const priceText = (price: string, scheduled: { from: string; price: string }[]) =>
  `${price}${scheduled.map((s) => ` (${s.price} from ${s.from})`).join('')}`

export function diffApple(
  desired: AppleDesired[],
  observed: AppleObserved,
  opts: { extras: boolean } = { extras: true },
): Diff<AppleAction> {
  const rows: StatusRow[] = []
  const actions: AppleAction[] = []
  const byId = new Map(observed.iaps.map((i) => [i.productId, i]))
  const approved = new Set(observed.iaps.filter((i) => i.state === 'APPROVED').map((i) => i.type))
  const act = (id: string, kind: string, summary: string, payload?: unknown) =>
    actions.push({ store: 'apple', id, kind, summary, payload })

  for (const d of desired) {
    const o = byId.get(d.productId)
    const notes: string[] = []
    if (!approved.has(d.type)) {
      notes.push(
        `the first ${TYPE_WORD[d.type]} ships with the app's next version: submit it from App Store Connect`,
      )
    }
    for (const s of d.scheduled) notes.push(`scheduled ${s.price} from ${s.from}`)
    if (!d.screenshot) notes.push('no review screenshot: App Store Connect keeps it MISSING_METADATA')

    if (!o) {
      act(d.productId, 'create', 'create', { attributes: createAttributes(d) })
      act(d.productId, 'localizations', `localization ${Object.keys(d.localizations).join(', ')}`, {
        locales: d.localizations,
      })
      act(d.productId, 'price', `price ${priceText(d.price, d.scheduled)}`, {
        price: d.price,
        scheduled: d.scheduled,
      })
      act(d.productId, 'availability', 'availability')
      if (d.screenshot) act(d.productId, 'screenshot', 'screenshot', { screenshot: d.screenshot })
      rows.push({ store: 'apple', id: d.productId, sync: 'missing', notes })
      continue
    }

    const fields: string[] = []
    if (o.type !== d.type) {
      fields.push('type')
      actions.push(
        errorAction('apple', d.productId, `type is ${o.type}; it cannot change: use a new product id`),
      )
    }
    if (d.type === 'NON_CONSUMABLE' && o.familySharable && !d.familySharable) {
      fields.push('familySharable')
      actions.push(
        errorAction(
          'apple',
          d.productId,
          'Family Sharing is on and Apple cannot turn it off; set familySharable: true',
        ),
      )
    }
    const patch: Record<string, unknown> = {}
    if (o.referenceName !== d.referenceName) patch.name = d.referenceName
    if (d.reviewNote !== undefined && (o.reviewNote ?? '') !== d.reviewNote) patch.reviewNote = d.reviewNote
    if (d.type === 'NON_CONSUMABLE' && d.familySharable && !o.familySharable) patch.familySharable = true
    if (Object.keys(patch).length) {
      const names = Object.keys(patch).map((k) => (k === 'name' ? 'referenceName' : k))
      fields.push(...names)
      act(d.productId, 'update', `update ${names.join(', ')}`, { attributes: patch })
    }

    const changedLocales: Record<string, { name: string; description: string }> = {}
    for (const [locale, l] of Object.entries(d.localizations)) {
      const have = o.localizations.find((x) => x.locale === locale)
      if (!have || have.name !== l.name || have.description !== l.description) changedLocales[locale] = l
    }
    if (Object.keys(changedLocales).length) {
      fields.push(...Object.keys(changedLocales).map((l) => `localization ${l}`))
      const newVersion = o.hasDraft ? '' : ' (new version)'
      act(
        d.productId,
        'localizations',
        `localization ${Object.keys(changedLocales).join(', ')}${newVersion}`,
        {
          locales: changedLocales,
        },
      )
    }
    for (const extra of o.localizations.filter((x) => !(x.locale in d.localizations))) {
      notes.push(`localization ${extra.locale} is not in the file (kept)`)
    }

    const have = observedPrices(o.prices, observed.today)
    const samePlan =
      have.current !== undefined &&
      samePrice(have.current, d.price) &&
      have.scheduled.length === d.scheduled.length &&
      have.scheduled.every(
        (s, i) => s.from === d.scheduled[i]!.from && samePrice(s.price, d.scheduled[i]!.price),
      )
    if (!samePlan) {
      fields.push('price')
      act(d.productId, 'price', `price ${priceText(d.price, d.scheduled)}`, {
        price: d.price,
        scheduled: d.scheduled,
      })
    }

    if (!o.availability) {
      fields.push('availability')
      act(d.productId, 'availability', 'availability')
    }

    if (d.screenshot) {
      const s = o.screenshot
      if (!s) {
        fields.push('screenshot')
        act(d.productId, 'screenshot', 'screenshot', { screenshot: d.screenshot })
      } else {
        const problem = screenshotProblem(s, d.screenshot)
        if (problem) {
          fields.push('screenshot')
          notes.push(problem)
        }
      }
    }

    rows.push({
      store: 'apple',
      id: d.productId,
      sync: fields.length ? 'differs' : 'in-sync',
      ...(fields.length ? { fields } : {}),
      storeState: [o.state, o.version?.state ? `version ${o.version.state}` : undefined]
        .filter(Boolean)
        .join(' · '),
      notes,
    })
  }

  if (opts.extras) {
    const wanted = new Set(desired.map((d) => d.productId))
    for (const o of observed.iaps) {
      if (!wanted.has(o.productId)) {
        rows.push({
          store: 'apple',
          id: o.productId,
          sync: 'extra',
          storeState: o.state,
          notes: ['not in the file (left alone)'],
        })
      }
    }
  }
  return { rows, actions }
}

function createAttributes(d: AppleDesired): Record<string, unknown> {
  return {
    name: d.referenceName,
    productId: d.productId,
    inAppPurchaseType: d.type,
    ...(d.reviewNote !== undefined ? { reviewNote: d.reviewNote } : {}),
    // Family Sharing exists for non-consumables only.
    ...(d.type === 'NON_CONSUMABLE' ? { familySharable: d.familySharable } : {}),
  }
}
