import type { KitContext } from '../../cli/command'
import { requireProject } from '../../cli/command'
import pc from 'picocolors'
import { ExitCode, KitError } from '../errors'
import { emitJson } from '../log'
import { confirm } from '../prompt'
import { redact } from '../secrets'
import { runSteps, type Step, type StepFlags } from '../steps'
import { appleAdapter } from './apple'
import { appleSubscriptionsAdapter } from './apple-subscriptions'
import { iapCreds } from './creds'
import { createClient, createPacer } from './http'
import { requireCatalog } from './load'
import {
  appleDesired,
  appleSubscriptionsDesired,
  type Catalog,
  pacificToday,
  playDesired,
  playSubscriptionsDesired,
  rcDesired,
  rcOfferingsDesired,
  type StoreTargets,
  storeTargets,
} from './model'
import { jsonDocument, planLines, type StoreReport, statusLines } from './plan-print'
import { playAdapter } from './play'
import { playSubscriptionsAdapter } from './play-subscriptions'
import { revenuecatAdapter } from './revenuecat'
import { revenuecatOfferingsAdapter } from './revenuecat-offerings'
import { type Action, type ActionResult, STORE_NAME, STORES, type Store, type StoreAdapter } from './types'

/**
 * `kit iap status` and `kit iap sync` (plan-4 §2, §4, §14): observe every selected store (reads
 * only), diff against the product file, print; `sync` then confirms and applies. A store is one or
 * more adapters (one-time products, subscriptions, offerings) printed as one block and applied in
 * that order. Apple and Play apply concurrently, RevenueCat after them. A store without credentials is skipped; a failed action
 * skips the rest of that product on that store; the summary names every failure.
 */

export interface IapRunOptions {
  mode: 'status' | 'sync'
  stores: string[]
  products: string[]
  /** Subscriptions: apply a changed price to new subscribers (never migrates existing ones). */
  allowPriceChange?: boolean
}

type AnyAdapter = StoreAdapter<unknown, unknown>

/** One adapter of a store (one-time products, subscriptions, offerings) and what it should hold. */
interface Part {
  /** What the part holds, for progress lines. */
  name: 'products' | 'subscriptions' | 'offerings'
  adapter: AnyAdapter
  desired: unknown[]
  observed?: unknown
}

/** One store: its parts run in order and print as one block. */
interface Unit {
  report: StoreReport
  parts: Part[]
  /** Which part applies each planned action. */
  owner: Map<Action, Part>
  /** Where the store's client reports each request; the running step points it at its tree line. */
  progress: (line: string) => void
}

function select(targets: StoreTargets, wanted: string[]): Store[] {
  const configured = STORES.filter((s) => targets[s])
  if (!configured.length) {
    throw new KitError(
      'iap configures no store',
      'Add iap.apple, iap.play or iap.revenuecat to kit.config.ts',
      ExitCode.config,
    )
  }
  if (!wanted.length) return configured
  for (const s of wanted) {
    if (!(STORES as readonly string[]).includes(s)) {
      throw new KitError(`Unknown store "${s}"`, `Use ${STORES.join(', ')}`, ExitCode.usage)
    }
    if (!configured.includes(s as Store)) {
      throw new KitError(
        `iap.${s} is not configured`,
        `Add it to kit.config.ts, or drop --store ${s}`,
        ExitCode.usage,
      )
    }
  }
  return configured.filter((s) => wanted.includes(s))
}

/** `--product` takes product, subscription and offering ids. */
function filterCatalog(catalog: Catalog, ids: string[]): Catalog {
  if (!ids.length) return catalog
  const known = new Set([
    ...catalog.products.map((p) => p.id),
    ...catalog.subscriptions.map((s) => s.id),
    ...catalog.offerings.map((o) => o.id),
  ])
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length) {
    throw new KitError(`Not in the product file: ${unknown.join(', ')}`, undefined, ExitCode.usage)
  }
  return {
    ...catalog,
    products: catalog.products.filter((p) => ids.includes(p.id)),
    subscriptions: catalog.subscriptions.filter((s) => ids.includes(s.id)),
    offerings: catalog.offerings.filter((o) => ids.includes(o.id)),
  }
}

interface BuildInput {
  targets: StoreTargets
  /** The whole file: decides which parts a store has, and what offering packages point at. */
  full: Catalog
  /** What this run asked for (`--product`). */
  catalog: Catalog
  today: string
  allowPriceChange: boolean
}

function build(store: Store, input: BuildInput): Unit {
  const { targets, full, catalog, today, allowPriceChange } = input
  const label = {
    apple: `${STORE_NAME.apple} (${targets.apple?.bundleId})`,
    play: `${STORE_NAME.play} (${targets.play?.packageName})`,
    revenuecat: `${STORE_NAME.revenuecat} (${targets.revenuecat?.projectId})`,
  }[store]
  const unit: Unit = {
    report: { store, label, rows: [], actions: [] },
    parts: [],
    owner: new Map(),
    progress: () => {},
  }
  const onProgress = (line: string) => unit.progress(line)
  const creds = iapCreds(store, targets)
  if (!creds.ok) {
    unit.report.skipped = creds.reason
    return unit
  }
  // A part that the file has nothing for is left out: no requests, no extra scopes.
  const part = (name: Part['name'], adapter: unknown, desired: unknown[], wanted: boolean) => {
    if (wanted) unit.parts.push({ name, adapter: adapter as AnyAdapter, desired })
  }
  const hasProducts = full.products.length > 0
  const hasSubscriptions = full.subscriptions.length > 0
  if (store === 'apple') {
    const client = createClient({ store, token: creds.token, onProgress })
    const bundleId = targets.apple!.bundleId
    part('products', appleAdapter(client, { bundleId, today }), appleDesired(catalog, today), hasProducts)
    part(
      'subscriptions',
      appleSubscriptionsAdapter(client, { bundleId, today, allowPriceChange }),
      appleSubscriptionsDesired(catalog),
      hasSubscriptions,
    )
  } else if (store === 'play') {
    const client = createClient({ store, token: creds.token, onProgress })
    const packageName = targets.play!.packageName
    part('products', playAdapter(client, { packageName }), playDesired(catalog, today), hasProducts)
    part(
      'subscriptions',
      playSubscriptionsAdapter(client, { packageName, allowPriceChange }),
      playSubscriptionsDesired(catalog),
      hasSubscriptions,
    )
  } else {
    // RevenueCat allows 60 project-configuration calls a minute, shared by every endpoint.
    const pace = Number(process.env.KIT_RC_PACE_MS ?? 1000)
    const client = createClient({ store, token: creds.token, pace: createPacer(pace), onProgress })
    const apps = { apple: !!targets.apple, play: !!targets.play }
    const ids = {
      projectId: targets.revenuecat!.projectId,
      bundleId: targets.apple?.bundleId,
      packageName: targets.play?.packageName,
    }
    // Products first: offering packages attach the RevenueCat products this part creates.
    part(
      'products',
      revenuecatAdapter(client, ids),
      rcDesired(catalog, apps),
      hasProducts || hasSubscriptions,
    )
    part(
      'offerings',
      revenuecatOfferingsAdapter(client, { ...ids, products: rcDesired(full, apps) }),
      rcOfferingsDesired(catalog),
      full.offerings.length > 0,
    )
  }
  if (unit.parts[0]) unit.report.label = unit.parts[0].adapter.label
  return unit
}

const message = (e: unknown): string => redact(e instanceof Error ? e.message : String(e))

/**
 * Parts observe one after another (they share the store's client and its pacing). A part that
 * fails to read is reported on its own; the store's other parts still plan and apply. Under a
 * `--product` filter a part with nothing asked of it is not read at all.
 */
async function observe(unit: Unit, extras: boolean, say: Say = () => {}): Promise<void> {
  const errors: string[] = []
  for (const part of unit.parts) {
    if (!extras && !part.desired.length) continue
    say(`Reading ${part.name}`)
    try {
      part.observed = await part.adapter.observe(part.desired)
      const { rows, actions } = part.adapter.diff(part.desired, part.observed, { extras })
      const planned = part.adapter.prepare ? await part.adapter.prepare(actions, part.observed) : actions
      unit.report.rows.push(...rows)
      unit.report.actions.push(...planned)
      for (const a of planned) unit.owner.set(a, part)
    } catch (e) {
      const hint = e instanceof KitError ? e.hint : undefined
      const text = `${message(e)}${hint ? ` (${hint})` : ''}`
      errors.push(unit.parts.length > 1 ? `${part.adapter.label}: ${text}` : text)
    }
  }
  if (errors.length) unit.report.error = errors.join('; ')
}

async function apply(unit: Unit, say: Say = () => {}): Promise<void> {
  const results: ActionResult[] = []
  const failed = new Set<string>()
  const total = unit.report.actions.length
  for (const [i, action] of unit.report.actions.entries()) {
    say(`${i + 1}/${total} ${action.id}: ${action.summary}`)
    if (failed.has(action.id)) {
      results.push({ id: action.id, kind: action.kind, ok: false, skipped: true })
      continue
    }
    try {
      await unit.owner.get(action)!.adapter.apply(action)
      results.push({ id: action.id, kind: action.kind, ok: true })
    } catch (e) {
      failed.add(action.id)
      results.push({ id: action.id, kind: action.kind, ok: false, error: message(e) })
    }
  }
  unit.report.results = results
}

/** Sets a store's progress line: the running step's line, plus the request in flight when `detail`. */
type Say = (line: string) => void

/**
 * One tree line per store while `run` works on it. The store's client reports each request under
 * the current line when `detail` is on (a terminal, or --verbose); in CI one line per request is noise.
 * A store left with `report.error` (or `failed`) shows as failed; the report still carries it.
 */
function storeStep(
  unit: Unit,
  detail: boolean,
  run: (say: Say) => Promise<void>,
  failed: () => string | undefined,
): Step {
  return {
    title: unit.report.label,
    task: async (update) => {
      let current = ''
      unit.progress = detail ? (line) => update(`${current} ${pc.dim(`· ${line}`)}`) : () => {}
      try {
        await run((line) => {
          current = line
          update(line)
        })
      } finally {
        unit.progress = () => {}
      }
      const error = failed()
      if (error) throw new Error(error)
    },
  }
}

export async function runIap(
  ctx: Pick<KitContext, 'root' | 'config' | 'flags' | 'log'>,
  opts: IapRunOptions,
): Promise<void> {
  const { root, config } = requireProject(ctx)
  const { iap, catalog: full } = requireCatalog(root, config, ctx.log)
  const targets = storeTargets(config, iap)
  const stores = select(targets, opts.stores)
  const catalog = filterCatalog(full, opts.products)
  const today = pacificToday()
  const allowPriceChange = !!opts.allowPriceChange
  const units = stores.map((s) => build(s, { targets, full, catalog, today, allowPriceChange }))
  const say = (lines: string[]) => {
    if (!ctx.flags.json) for (const l of lines) ctx.log.info(l)
  }

  const flags: StepFlags = ctx.flags
  const detail = flags.verbose || (!!process.stderr.isTTY && !flags.ci)
  for (const u of units) if (u.report.skipped) ctx.log.warn(`${u.report.label}: skipped, ${u.report.skipped}`)
  const live = units.filter((u) => !u.report.skipped)
  if (!flags.json && live.length)
    ctx.log.step(`Reading ${live.length === 1 ? 'the store' : `${live.length} stores`}`)
  await runSteps(
    live.map((u) =>
      storeStep(
        u,
        detail,
        (say) => observe(u, !opts.products.length, say),
        () => u.report.error,
      ),
    ),
    flags,
    { concurrent: true },
  )
  const reports = units.map((u) => u.report)
  const storeFailed = reports.some((r) => r.error)

  if (opts.mode === 'status') {
    say(statusLines(reports))
    if (ctx.flags.json) emitJson(jsonDocument(reports, !storeFailed))
    if (storeFailed) process.exitCode = ExitCode.failed
    return
  }

  const total = reports.reduce((n, r) => n + r.actions.length, 0)
  say(planLines(reports))
  if (!total || ctx.flags.dryRun) {
    if (!total)
      ctx.log.success(
        reports.every((r) => r.skipped)
          ? 'Nothing to do: no store has credentials'
          : storeFailed
            ? 'Nothing to apply in the stores that answered'
            : 'Nothing to do: every store matches the file',
      )
    else ctx.log.info('Dry run: nothing applied')
    if (ctx.flags.json) emitJson(jsonDocument(reports, !storeFailed))
    if (storeFailed) process.exitCode = ExitCode.failed
    return
  }
  if (!(await confirm(ctx.flags, `Apply ${total} change${total === 1 ? '' : 's'}?`))) {
    ctx.log.info('Nothing applied')
    return
  }

  const byStore = (s: Store) => units.filter((u) => u.report.store === s && u.report.actions.length)
  const applySteps = (us: Unit[]) =>
    us.map((u) =>
      storeStep(
        u,
        detail,
        (say) => apply(u, say),
        () => {
          const bad = (u.report.results ?? []).filter((x) => !x.ok && !x.skipped).length
          return bad ? `${bad} failed` : undefined
        },
      ),
    )
  if (!flags.json) ctx.log.step(`Applying ${total} change${total === 1 ? '' : 's'}`)
  // Apple and Play together; RevenueCat after, since its products point at theirs.
  await runSteps(applySteps([...byStore('apple'), ...byStore('play')]), flags, { concurrent: true })
  await runSteps(applySteps(byStore('revenuecat')), flags)

  let failures = 0
  for (const r of reports) {
    if (!r.results) continue
    const bad = r.results.filter((x) => !x.ok && !x.skipped)
    const done = r.results.filter((x) => x.ok).length
    failures += bad.length
    if (!bad.length) ctx.log.success(`${r.label}: ${done} applied`)
    else {
      ctx.log.error(`${r.label}: ${done} applied, ${bad.length} failed`)
      for (const b of bad) ctx.log.info(`  ${b.id} (${b.kind}): ${b.error}`)
    }
  }
  const ok = !failures && !storeFailed
  if (ctx.flags.json) emitJson(jsonDocument(reports, ok))
  if (!ok) process.exitCode = ExitCode.failed
}
