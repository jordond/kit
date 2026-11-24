import { observedPrices, screenshotProblem } from './apple'
import { type AppleSubscriptionDesired, type AppleSubscriptionPlanDesired, samePrice } from './model'
import { type Action, type Diff, errorAction, type StatusRow } from './types'

/**
 * Pure half of the App Store Connect subscriptions adapter (plan-4 §5 Apple "Subscriptions",
 * §14): what is in the store (`AppleSubscriptionsObserved`) against what the file wants, as status
 * rows and ordered actions. Never deletes: a differing trial or screenshot is a note.
 */

export interface AppleSubPlan {
  ascId: string
  productId: string
  name: string
  period: string
  groupLevel?: number
  familySharable: boolean
  reviewNote?: string
  state?: string
  /** The version kit reads localizations from: the draft, else the latest. */
  version?: { id: string; state?: string }
  hasDraft: boolean
  localizations: { id: string; locale: string; name: string; description: string }[]
  /** USA prices. */
  prices: { startDate: string | null; endDate: string | null; customerPrice: string; preserved?: boolean }[]
  /** Every USA price row the store listed, including ones kit could not read a price from. */
  priceRows?: number
  availability: boolean
  /** Introductory offers (any mode). */
  offers: { id: string; mode: string; duration: string; territory?: string; endDate?: string }[]
  screenshot?: { id: string; checksum?: string; fileName?: string; fileSize?: number; state?: string }
}

export interface AppleSubGroup {
  ascId: string
  /** Kit's group key: the file subscription id. */
  referenceName: string
  version?: { id: string; state?: string }
  hasDraft: boolean
  localizations: { id: string; locale: string; name: string }[]
  plans: AppleSubPlan[]
}

export interface AppleSubscriptionsObserved {
  appId: string
  bundleId: string
  today: string
  groups: AppleSubGroup[]
  /** Every territory id; set when some plan already has a trial. */
  territories?: string[]
}

export interface AppleSubscriptionsDiffOptions {
  /** False under a `--product` filter: leave out groups the run did not ask about. Default true. */
  extras?: boolean
  /** `--allow-price-change`: a changed USA price on an existing plan becomes a price action. */
  allowPriceChange?: boolean
}

export type AppleSubscriptionAction = Action

export const PRICE_CHANGE_NOTE = 'needs --allow-price-change; existing subscribers keep their price'

const shortPlan = (d: AppleSubscriptionDesired, p: AppleSubscriptionPlanDesired) =>
  p.ref.startsWith(`${d.id}:`) ? p.ref.slice(d.id.length + 1) : p.ref

type Act = (id: string, kind: string, summary: string, payload?: unknown) => void

export function diffAppleSubscriptions(
  desired: AppleSubscriptionDesired[],
  observed: AppleSubscriptionsObserved,
  opts: AppleSubscriptionsDiffOptions = {},
): Diff<AppleSubscriptionAction> {
  const rows: StatusRow[] = []
  const actions: AppleSubscriptionAction[] = []
  const act: Act = (id, kind, summary, payload) =>
    actions.push({ store: 'apple', id, kind, summary, payload })
  const groups = new Map(observed.groups.map((g) => [g.referenceName, g]))
  const owner = new Map<string, AppleSubGroup>()
  for (const g of observed.groups) for (const p of g.plans) owner.set(p.productId, g)
  const approved = observed.groups.some((g) => g.plans.some((p) => p.state === 'APPROVED'))

  for (const d of desired) {
    const g = groups.get(d.id)
    const fields: string[] = []
    const notes: string[] = []
    if (!approved) {
      notes.push(
        "the first auto-renewable subscription ships with the app's next version, with its group: submit it from App Store Connect",
      )
    }

    if (!g) {
      act(d.id, 'group', 'group', { name: d.id })
      act(d.id, 'group-localizations', `group localization ${Object.keys(d.groupLocalizations).join(', ')}`, {
        locales: d.groupLocalizations,
      })
    } else {
      const changed: Record<string, string> = {}
      for (const [locale, name] of Object.entries(d.groupLocalizations)) {
        if (g.localizations.find((l) => l.locale === locale)?.name !== name) changed[locale] = name
      }
      if (Object.keys(changed).length) {
        fields.push(...Object.keys(changed).map((l) => `group localization ${l}`))
        act(
          d.id,
          'group-localizations',
          `group localization ${Object.keys(changed).join(', ')}${g.hasDraft || !g.version ? '' : ' (new version)'}`,
          { locales: changed },
        )
      }
      for (const l of g.localizations.filter((x) => !(x.locale in d.groupLocalizations))) {
        notes.push(`group localization ${l.locale} is not in the file (kept)`)
      }
    }

    for (const plan of d.plans) {
      const short = shortPlan(d, plan)
      const o = g?.plans.find((p) => p.productId === plan.productId)
      if (!o) {
        const other = owner.get(plan.productId)
        if (other) {
          fields.push(`${short}: product id`)
          actions.push(
            errorAction(
              'apple',
              d.id,
              `${plan.productId} already exists in subscription group ${other.referenceName}; a product id cannot move: use a new product id`,
            ),
          )
          continue
        }
        if (g) fields.push(`${short}: missing`)
        newPlan(act, d, plan, short)
        if (!plan.screenshot) {
          notes.push(`${short}: no review screenshot (App Store Connect keeps it MISSING_METADATA)`)
        }
        continue
      }
      existingPlan(
        act,
        actions,
        fields,
        notes,
        d,
        plan,
        short,
        o,
        observed.today,
        !!opts.allowPriceChange,
        observed.territories,
      )
    }

    for (const p of g?.plans ?? []) {
      if (!d.plans.some((x) => x.productId === p.productId)) {
        notes.push(`plan ${p.productId} is not in the file (kept)`)
      }
    }

    const states = (g?.plans ?? []).flatMap((p) => {
      const plan = d.plans.find((x) => x.productId === p.productId)
      return plan ? [`${shortPlan(d, plan)} ${p.state ?? '?'}`] : []
    })
    rows.push({
      store: 'apple',
      id: d.id,
      sync: !g ? 'missing' : fields.length ? 'differs' : 'in-sync',
      ...(g && fields.length ? { fields } : {}),
      ...(states.length ? { storeState: states.join(' · ') } : {}),
      notes,
    })
  }

  if (opts.extras ?? true) {
    const wanted = new Set(desired.map((d) => d.id))
    for (const g of observed.groups) {
      if (!wanted.has(g.referenceName)) {
        rows.push({
          store: 'apple',
          id: g.referenceName,
          sync: 'extra',
          notes: ['subscription group is not in the file (left alone)'],
        })
      }
    }
  }
  return { rows, actions }
}

function createAttributes(p: AppleSubscriptionPlanDesired): Record<string, unknown> {
  return {
    name: p.name,
    productId: p.productId,
    subscriptionPeriod: p.period,
    groupLevel: p.groupLevel,
    familySharable: p.familySharable,
    ...(p.reviewNote !== undefined ? { reviewNote: p.reviewNote } : {}),
  }
}

/** A plan the store does not have: everything, in the order Apple needs it. */
function newPlan(
  act: Act,
  d: AppleSubscriptionDesired,
  p: AppleSubscriptionPlanDesired,
  short: string,
): void {
  act(d.id, 'create', `${short}: create`, { plan: p.productId, attributes: createAttributes(p) })
  act(d.id, 'localizations', `${short}: localization ${Object.keys(p.localizations).join(', ')}`, {
    plan: p.productId,
    locales: p.localizations,
  })
  act(d.id, 'availability', `${short}: availability`, { plan: p.productId })
  act(d.id, 'price', `${short}: price ${p.price}`, { plan: p.productId, price: p.price, preserve: false })
  if (p.trial) act(d.id, 'trial', `${short}: trial ${p.trial}`, { plan: p.productId, duration: p.trial })
  if (p.screenshot) {
    act(d.id, 'screenshot', `${short}: screenshot`, { plan: p.productId, screenshot: p.screenshot })
  }
}

function existingPlan(
  act: Act,
  actions: AppleSubscriptionAction[],
  fields: string[],
  notes: string[],
  d: AppleSubscriptionDesired,
  p: AppleSubscriptionPlanDesired,
  short: string,
  o: AppleSubPlan,
  today: string,
  allowPriceChange: boolean,
  territories?: string[],
): void {
  const field = (f: string) => fields.push(`${short}: ${f}`)
  const productId = p.productId

  if (o.period !== p.period) {
    field('subscriptionPeriod')
    actions.push(
      errorAction(
        'apple',
        d.id,
        `${short}: the period is ${o.period} in the store; it cannot change: use a new product id`,
      ),
    )
  }
  if (o.familySharable && !p.familySharable) {
    field('familySharable')
    actions.push(
      errorAction(
        'apple',
        d.id,
        `${short}: Family Sharing is on and Apple cannot turn it off; set familySharable: true`,
      ),
    )
  }
  const patch: Record<string, unknown> = {}
  if (o.name !== p.name) patch.name = p.name
  if (o.groupLevel !== p.groupLevel) patch.groupLevel = p.groupLevel
  if (p.reviewNote !== undefined && (o.reviewNote ?? '') !== p.reviewNote) patch.reviewNote = p.reviewNote
  if (p.familySharable && !o.familySharable) patch.familySharable = true
  if (Object.keys(patch).length) {
    const names = Object.keys(patch).map((k) => (k === 'name' ? 'referenceName' : k))
    for (const n of names) field(n)
    act(d.id, 'update', `${short}: update ${names.join(', ')}`, { plan: productId, attributes: patch })
  }

  const changed: Record<string, { name: string; description: string }> = {}
  for (const [locale, l] of Object.entries(p.localizations)) {
    const have = o.localizations.find((x) => x.locale === locale)
    if (!have || have.name !== l.name || have.description !== l.description) changed[locale] = l
  }
  if (Object.keys(changed).length) {
    for (const l of Object.keys(changed)) field(`localization ${l}`)
    act(
      d.id,
      'localizations',
      `${short}: localization ${Object.keys(changed).join(', ')}${o.hasDraft || !o.version ? '' : ' (new version)'}`,
      { plan: productId, locales: changed },
    )
  }
  for (const x of o.localizations.filter((l) => !(l.locale in p.localizations))) {
    notes.push(`${short}: localization ${x.locale} is not in the file (kept)`)
  }

  if (!o.availability) {
    field('availability')
    act(d.id, 'availability', `${short}: availability`, { plan: productId })
  }

  const have = observedPrices(o.prices, today)
  if (have.current === undefined && !(o.priceRows ?? o.prices.length)) {
    // No price at all: the plan is new (or its first pricing never finished).
    field('price')
    act(d.id, 'price', `${short}: price ${p.price}`, { plan: productId, price: p.price, preserve: false })
  } else if (have.current === undefined) {
    // Prices exist but none reads as current: never reprice without keeping subscribers.
    field('price')
    if (!allowPriceChange) {
      notes.push(`${short}: the store has prices but no current USA price kit can read: ${PRICE_CHANGE_NOTE}`)
    } else {
      act(d.id, 'price', `${short}: price ${p.price} (existing subscribers keep theirs)`, {
        plan: productId,
        price: p.price,
        preserve: true,
      })
    }
  } else if (!have.inEffect.some((x) => samePrice(x, p.price))) {
    field('price')
    const move = `${have.current} in the store, ${p.price} in the file`
    if (!allowPriceChange) {
      notes.push(`${short}: price ${move}: ${PRICE_CHANGE_NOTE}`)
    } else {
      if (Number(p.price) < Number(have.current)) {
        notes.push(`${short}: a price decrease reaches existing subscribers too (Apple cannot preserve it)`)
      }
      act(d.id, 'price', `${short}: price ${have.current} → ${p.price} (existing subscribers keep theirs)`, {
        plan: productId,
        price: p.price,
        preserve: true,
      })
    }
  }
  for (const s of have.scheduled) notes.push(`${short}: price ${s.price} is scheduled from ${s.from} (kept)`)

  // Trials are never replaced: only created on a plan with no introductory offer.
  const trials = o.offers.filter((x) => x.mode === 'FREE_TRIAL')
  const durations = [...new Set(trials.map((x) => x.duration))].join(', ')
  if (p.trial) {
    const missing =
      territories && trials.length === o.offers.length && trials.every((x) => x.territory)
        ? territories.filter((t) => !trials.some((x) => x.territory === t))
        : []
    if (!o.offers.length) {
      act(d.id, 'trial', `${short}: trial ${p.trial}`, { plan: productId, duration: p.trial })
    } else if (missing.length && trials.every((x) => x.duration === p.trial)) {
      // An earlier run stopped part way: finish the same trial, never change it.
      field('trial')
      notes.push(`${short}: the trial is missing in ${missing.length} territories (an earlier sync stopped)`)
      act(d.id, 'trial', `${short}: trial ${p.trial} in ${missing.length} more territories`, {
        plan: productId,
        duration: p.trial,
        territories: missing,
      })
    } else if (!trials.length || trials.some((x) => x.duration !== p.trial)) {
      field('trial')
      notes.push(
        `${short}: trial is ${durations || 'another introductory offer'} in the store, ${p.trial} in the file: change it in App Store Connect`,
      )
    }
  } else if (trials.length) {
    field('trial')
    notes.push(
      `${short}: the store has a ${durations} trial the file does not: change it in App Store Connect`,
    )
  }

  if (p.screenshot) {
    const s = o.screenshot
    if (!s) {
      field('screenshot')
      act(d.id, 'screenshot', `${short}: screenshot`, { plan: productId, screenshot: p.screenshot })
    } else {
      const problem = screenshotProblem(s, p.screenshot)
      if (problem) {
        field('screenshot')
        notes.push(`${short}: ${problem}`)
      }
    }
  } else if (!o.screenshot) {
    notes.push(`${short}: no review screenshot (App Store Connect keeps it MISSING_METADATA)`)
  }
}
