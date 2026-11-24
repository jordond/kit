import pkg from '../../../package.json' with { type: 'json' }
import type { Flags } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import { emitJson, type Logger } from '../log'
import { checkProductFile, type Issue } from './check'
import { type Iap, readProductFile, requireIap } from './file'
import { type Catalog, pacificToday, resolveCatalog } from './model'

export interface Loaded {
  iap: Iap
  label: string
  issues: Issue[]
  /** Set when the file has no errors. */
  catalog?: Catalog
}

/** Read, validate and resolve the product file. */
export function loadIap(root: string, config: KitConfig, today = pacificToday()): Loaded {
  const iap = requireIap(config)
  const loaded = readProductFile(root, iap)
  if (!loaded.file) {
    return {
      iap,
      label: loaded.label,
      issues: loaded.errors.map((e) => {
        const at = e.indexOf(': ')
        return { level: 'error', path: e.slice(0, at), message: e.slice(at + 2) }
      }),
    }
  }
  const issues = checkProductFile(loaded.file, { root, today, version: pkg.version, raw: loaded.raw })
  return {
    iap,
    label: loaded.label,
    issues,
    catalog: issues.some((i) => i.level === 'error') ? undefined : resolveCatalog(root, iap, loaded.file),
  }
}

export function printIssues(log: Logger, label: string, issues: Issue[]): void {
  for (const i of issues) {
    const line = `${label} ${i.path}: ${i.message}`
    if (i.level === 'error') log.error(line)
    else log.warn(line)
  }
}

/** `kit iap check`: exit 1 on any error; warnings print and pass. */
export function runCheck(root: string, config: KitConfig, flags: Pick<Flags, 'json'>, log: Logger): boolean {
  const { label, issues, catalog } = loadIap(root, config)
  const errors = issues.filter((i) => i.level === 'error').length
  if (flags.json) emitJson({ file: label, ok: errors === 0, issues })
  else {
    printIssues(log, label, issues)
    if (!errors) {
      const n = catalog!.products.length
      const s = catalog!.subscriptions.length
      log.success(
        `${label}: ${n} product${n === 1 ? '' : 's'}${s ? `, ${s} subscription${s === 1 ? '' : 's'}` : ''}`,
      )
    }
  }
  if (errors) process.exitCode = ExitCode.failed
  return errors === 0
}

/** The catalog for `status` and `sync`: exit 1 when the file has errors, refuse subscriptions (phase 2). */
export function requireCatalog(root: string, config: KitConfig, log: Logger): { iap: Iap; catalog: Catalog } {
  const { iap, label, issues, catalog } = loadIap(root, config)
  if (!catalog) {
    printIssues(log, label, issues)
    throw new KitError(`${label} has errors`, 'Fix them; `kit iap check` lists them')
  }
  if (catalog.subscriptions.length) {
    throw new KitError(
      `${label} has subscriptions; kit iap syncs one-time products only (subscriptions are phase 2)`,
      'Move them out of the file for now, or sync them by hand in each console',
      ExitCode.usage,
    )
  }
  return { iap, catalog }
}
