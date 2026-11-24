import type { KitContext } from '../../cli/command'
import { requireProject } from '../../cli/command'
import { ExitCode, KitError } from '../errors'
import { emitJson } from '../log'
import { confirm } from '../prompt'
import { redact } from '../secrets'
import { appleAdapter } from './apple'
import { iapCreds } from './creds'
import { createClient, createPacer } from './http'
import { requireCatalog } from './load'
import {
  appleDesired,
  type Catalog,
  pacificToday,
  playDesired,
  rcDesired,
  type StoreTargets,
  storeTargets,
} from './model'
import { jsonDocument, planLines, type StoreReport, statusLines } from './plan-print'
import { playAdapter } from './play'
import { revenuecatAdapter } from './revenuecat'
import { type Action, type ActionResult, STORE_NAME, STORES, type Store, type StoreAdapter } from './types'

/**
 * `kit iap status` and `kit iap sync` (plan-4 §2, §4): observe every selected store (reads only),
 * diff against the product file, print; `sync` then confirms and applies. Apple and Play apply
 * concurrently, RevenueCat after them. A store without credentials is skipped; a failed action
 * skips the rest of that product on that store; the summary names every failure.
 */

export interface IapRunOptions {
  mode: 'status' | 'sync'
  stores: string[]
  products: string[]
}

interface Unit {
  report: StoreReport
  adapter?: StoreAdapter<unknown, unknown>
  desired: unknown[]
  observed?: unknown
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

function filterProducts(catalog: Catalog, ids: string[]): Catalog {
  if (!ids.length) return catalog
  const known = new Set(catalog.products.map((p) => p.id))
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length) {
    throw new KitError(`Not in the product file: ${unknown.join(', ')}`, undefined, ExitCode.usage)
  }
  return { ...catalog, products: catalog.products.filter((p) => ids.includes(p.id)) }
}

function build(store: Store, targets: StoreTargets, catalog: Catalog, today: string): Unit {
  const label = {
    apple: `${STORE_NAME.apple} (${targets.apple?.bundleId})`,
    play: `${STORE_NAME.play} (${targets.play?.packageName})`,
    revenuecat: `${STORE_NAME.revenuecat} (${targets.revenuecat?.projectId})`,
  }[store]
  const report: StoreReport = { store, label, rows: [], actions: [] }
  const creds = iapCreds(store, targets)
  const desired =
    store === 'apple'
      ? appleDesired(catalog, today)
      : store === 'play'
        ? playDesired(catalog, today)
        : rcDesired(catalog, { apple: !!targets.apple, play: !!targets.play })
  if (!creds.ok) {
    report.skipped = creds.reason
    return { report, desired }
  }
  let adapter: StoreAdapter<unknown, unknown>
  if (store === 'apple') {
    adapter = appleAdapter(createClient({ store, token: creds.token }), {
      bundleId: targets.apple!.bundleId,
      today,
    }) as StoreAdapter<unknown, unknown>
  } else if (store === 'play') {
    adapter = playAdapter(createClient({ store, token: creds.token }), {
      packageName: targets.play!.packageName,
    }) as StoreAdapter<unknown, unknown>
  } else {
    // RevenueCat allows 60 project-configuration calls a minute, shared by every endpoint.
    const pace = Number(process.env.KIT_RC_PACE_MS ?? 1000)
    adapter = revenuecatAdapter(createClient({ store, token: creds.token, pace: createPacer(pace) }), {
      projectId: targets.revenuecat!.projectId,
      bundleId: targets.apple?.bundleId,
      packageName: targets.play?.packageName,
    }) as StoreAdapter<unknown, unknown>
  }
  report.label = adapter.label
  return { report, adapter, desired }
}

const message = (e: unknown): string => redact(e instanceof Error ? e.message : String(e))

async function observe(unit: Unit, extras: boolean): Promise<void> {
  if (!unit.adapter) return
  try {
    unit.observed = await unit.adapter.observe(unit.desired)
    const { rows, actions } = unit.adapter.diff(unit.desired, unit.observed, { extras })
    unit.report.rows = rows
    unit.report.actions = unit.adapter.prepare ? await unit.adapter.prepare(actions, unit.observed) : actions
  } catch (e) {
    unit.report.error = message(e)
    const hint = e instanceof KitError ? e.hint : undefined
    if (hint) unit.report.error += ` (${hint})`
  }
}

async function apply(unit: Unit): Promise<void> {
  const results: ActionResult[] = []
  const failed = new Set<string>()
  for (const action of unit.report.actions as Action[]) {
    if (failed.has(action.id)) {
      results.push({ id: action.id, kind: action.kind, ok: false, skipped: true })
      continue
    }
    try {
      await unit.adapter!.apply(action)
      results.push({ id: action.id, kind: action.kind, ok: true })
    } catch (e) {
      failed.add(action.id)
      results.push({ id: action.id, kind: action.kind, ok: false, error: message(e) })
    }
  }
  unit.report.results = results
}

export async function runIap(
  ctx: Pick<KitContext, 'root' | 'config' | 'flags' | 'log'>,
  opts: IapRunOptions,
): Promise<void> {
  const { root, config } = requireProject(ctx)
  const { iap, catalog: full } = requireCatalog(root, config, ctx.log)
  const targets = storeTargets(config, iap)
  const stores = select(targets, opts.stores)
  const catalog = filterProducts(full, opts.products)
  const today = pacificToday()
  const units = stores.map((s) => build(s, targets, catalog, today))
  const say = (lines: string[]) => {
    if (!ctx.flags.json) for (const l of lines) ctx.log.info(l)
  }

  for (const u of units) if (u.report.skipped) ctx.log.warn(`${u.report.label}: skipped, ${u.report.skipped}`)
  await Promise.all(units.map((u) => observe(u, !opts.products.length)))
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

  const byStore = (s: Store) =>
    units.filter((u) => u.report.store === s && u.adapter && u.report.actions.length)
  await Promise.all([...byStore('apple'), ...byStore('play')].map(apply))
  await Promise.all(byStore('revenuecat').map(apply))

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
