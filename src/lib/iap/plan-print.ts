import pc from 'picocolors'
import type { Action, ActionResult, StatusRow, Store } from './types'

/** Plan, status and result output of `kit iap` (plan-4 §6). Human text goes to stderr. */

export interface StoreReport {
  store: Store
  label: string
  /** Not run: missing credentials. */
  skipped?: string
  /** Observation failed (bad credentials, app not found). */
  error?: string
  rows: StatusRow[]
  actions: Action[]
  results?: ActionResult[]
}

const SIGN: Record<StatusRow['sync'], string> = { missing: '+', differs: '~', 'in-sync': '=', extra: '?' }

function pad(s: string, n: number): string {
  return s.length >= n ? `${s} ` : s.padEnd(n)
}

function counts(r: StoreReport, plan: boolean): string {
  const n = (s: StatusRow['sync']) => r.rows.filter((x) => x.sync === s).length
  const parts = [`${n('missing')} create`, `${n('differs')} update`, `${n('in-sync')} in sync`]
  if (plan && r.store === 'revenuecat') {
    // Offering actions carry `offering/<key>` ids; their `attach` fills packages, not entitlements.
    const offering = (a: Action) => a.id.startsWith('offering/')
    const k = (kind: string, ofOffering = false) =>
      r.actions.filter((a) => a.kind === kind && offering(a) === ofOffering).length
    parts.push(`${k('product')} products, ${k('entitlement')} entitlements, ${k('attach')} attaches`)
    if (r.actions.some(offering)) {
      parts.push(`${k('offering', true)} offerings, ${k('package', true)} packages`)
    }
  }
  return parts.join(', ')
}

function heading(r: StoreReport, plan: boolean): string {
  const tail = r.skipped
    ? pc.yellow(`skipped: ${r.skipped}`)
    : r.error
      ? pc.red(`failed: ${r.error}`)
      : counts(r, plan)
  return `${pad(pc.bold(r.label), 40)} ${tail}`
}

/** What `sync` will do, per store. */
export function planLines(reports: StoreReport[]): string[] {
  const lines: string[] = []
  const extras: string[] = []
  for (const r of reports) {
    lines.push(heading(r, true))
    const width = Math.max(0, ...r.rows.map((x) => x.id.length)) + 2
    const ids = [...new Set(r.actions.map((a) => a.id))]
    for (const id of ids) {
      const acts = r.actions.filter((a) => a.id === id)
      const row = r.rows.find((x) => x.id === id)
      const error = acts.some((a) => a.kind === 'error')
      const sign = error ? pc.red('!') : row?.sync === 'missing' ? pc.green('+') : pc.yellow('~')
      lines.push(`  ${sign} ${pad(id, width)}${acts.map((a) => a.summary).join(' · ')}`)
    }
    for (const row of r.rows.filter((x) => x.sync === 'extra')) extras.push(`${r.store}: ${row.id}`)
  }
  if (extras.length) lines.push(pc.dim(`Extra (left alone): ${extras.join(', ')}`))
  return lines
}

/** `status`: every row with its store state and notes. */
export function statusLines(reports: StoreReport[]): string[] {
  const lines: string[] = []
  for (const r of reports) {
    lines.push(heading(r, false))
    const width = Math.max(0, ...r.rows.map((x) => x.id.length)) + 2
    for (const row of r.rows) {
      const sync =
        row.sync === 'differs'
          ? pc.yellow(`differs (${(row.fields ?? []).join(', ')})`)
          : row.sync === 'missing'
            ? pc.red('missing')
            : row.sync === 'extra'
              ? pc.dim('extra')
              : pc.green('in sync')
      lines.push(
        `  ${SIGN[row.sync]} ${pad(row.id, width)}${sync}${row.storeState ? pc.dim(`  ${row.storeState}`) : ''}`,
      )
      for (const note of row.notes ?? []) lines.push(pc.dim(`      ${note}`))
    }
  }
  return lines
}

/** The `--json` document (shape snapshot-tested). */
export function jsonDocument(reports: StoreReport[], ok: boolean): unknown {
  return {
    stores: Object.fromEntries(
      reports.map((r) => [
        r.store,
        {
          label: r.label,
          ...(r.skipped ? { skipped: r.skipped } : {}),
          ...(r.error ? { error: r.error } : {}),
          rows: r.rows,
          actions: r.actions.map(({ store: _s, payload: _p, ...a }) => a),
          ...(r.results ? { results: r.results } : {}),
        },
      ]),
    ),
    ok,
  }
}
