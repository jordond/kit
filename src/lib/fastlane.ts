import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { KitConfig } from '../config/schema'
import { onCleanup } from './cleanup'
import { ExitCode, KitError } from './errors'
import { type Env, runLines, runPiped } from './proc'
import { redact } from './secrets'

/**
 * Runs fastlane against kit's shared Fastfile and Gemfile (PLAN D7, S4).
 *
 * The app keeps a one-line `fastlane/Fastfile` that imports `KIT_FASTFILE`; kit runs
 * `bundle exec fastlane` from the app dir with BUNDLE_GEMFILE pointing at kit's Gemfile, the bundle
 * installed outside node_modules, and fastlane's report/docs writes sent to a temp dir.
 */

/** kit's package dir (holds `fastlane/` and `package.json`), from src/ or dist/. */
export function kitDir(): string {
  let dir = import.meta.dir
  while (true) {
    if (existsSync(join(dir, 'fastlane', 'Fastfile')) && existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('kit: cannot find its own fastlane/ directory')
    dir = parent
  }
}

/** The dir holding the app's `fastlane/Fastfile`: `release.fastlaneDir`, else gradle.root, else the root. */
export function appFastlaneDir(root: string, config: KitConfig): string {
  const candidates = config.release?.fastlaneDir
    ? [config.release.fastlaneDir]
    : [...(config.gradle ? [config.gradle.root] : []), '.']
  for (const c of candidates) {
    const dir = join(root, c)
    if (existsSync(join(dir, 'fastlane', 'Fastfile'))) return dir
  }
  const where = config.release?.fastlaneDir ?? config.gradle?.root ?? '.'
  throw new KitError(
    `No fastlane/Fastfile in ${where}`,
    `Create ${join(where, 'fastlane/Fastfile')} with: import(ENV.fetch("KIT_FASTFILE") { UI.user_error!("Run fastlane via \`kit fastlane ...\` or \`kit release ...\`") })`,
    ExitCode.config,
  )
}

function bundlePath(): string {
  if (process.env.KIT_BUNDLE_PATH) return process.env.KIT_BUNDLE_PATH
  if (process.env.CI && process.env.RUNNER_TEMP) return join(process.env.RUNNER_TEMP, 'kit-bundle')
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(cache, 'kit', 'bundle')
}

let reportDir: string | undefined
function runReportDir(): string {
  if (reportDir) return reportDir
  const dir = mkdtempSync(join(tmpdir(), 'kit-fastlane-'))
  reportDir = dir
  onCleanup(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The environment every fastlane run gets (D7 + S4). `appRoot` is the dir holding `fastlane/`. */
export function fastlaneEnv(appRoot: string): Record<string, string> {
  const kit = kitDir()
  const cache = dirname(bundlePath())
  return {
    BUNDLE_GEMFILE: join(kit, 'fastlane', 'Gemfile'),
    BUNDLE_FROZEN: 'true',
    BUNDLE_PATH: bundlePath(),
    BUNDLE_APP_CONFIG: join(cache, 'bundle-config'),
    KIT_FASTFILE: join(kit, 'fastlane', 'Fastfile'),
    KIT_APP_ROOT: appRoot,
    FASTLANE_SKIP_DOCS: '1',
    FL_REPORT_PATH: runReportDir(),
    FASTLANE_SKIP_UPDATE_CHECK: '1',
    FASTLANE_OPT_OUT_USAGE: '1',
    FASTLANE_HIDE_CHANGELOG: '1',
  }
}

let bundleReady = false

/** `bundle check`, and `bundle install` only when it fails (first run, or the lock changed). */
export async function ensureBundle(appRoot: string, onLine?: (line: string) => void): Promise<void> {
  if (bundleReady) return
  const env = fastlaneEnv(appRoot)
  if ((await runPiped(['bundle', 'check'], { cwd: appRoot, env })).code === 0) {
    bundleReady = true
    return
  }
  const { code, output } = await runLines(['bundle', 'install'], { cwd: appRoot, env, onLine })
  if (code !== 0) {
    throw new KitError(
      `bundle install failed (exit ${code})`,
      `Check Ruby and Bundler (kit's Gemfile.lock pins Bundler); output:\n${output.split('\n').slice(-15).join('\n')}`,
    )
  }
  bundleReady = true
}

/** Test seam. */
export function resetBundle(): void {
  bundleReady = false
}

const OUTPUT_LINE = /^(?:\[[^\]]*\]: )?KIT_([A-Z0-9_]+)=(.*)$/

/** `KIT_<KEY>=<value>` lines from lane output (an optional `[hh:mm:ss]: ` prefix allowed). Last wins. */
export function parseOutputs(output: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const m = Bun.stripANSI(line).trim().match(OUTPUT_LINE)
    if (m) out[m[1]!] = m[2]!.trim()
  }
  return out
}

export interface LaneResult {
  code: number
  output: string
  outputs: Record<string, string>
}

/**
 * Run `fastlane <platform> <lane>` from `appRoot`, lines redacted, `KIT_*` outputs parsed.
 * stdin is closed so a lane can never stop on a prompt.
 */
export async function runLane(
  appRoot: string,
  platform: 'ios' | 'android',
  lane: string,
  opts: { env?: Env; onLine?: (line: string) => void } = {},
): Promise<LaneResult> {
  await ensureBundle(appRoot, opts.onLine)
  const { code, output } = await runLines(['bundle', 'exec', 'fastlane', platform, lane], {
    cwd: appRoot,
    env: { ...fastlaneEnv(appRoot), ...opts.env },
    onLine: opts.onLine ? (l) => opts.onLine!(redact(l)) : undefined,
  })
  const clean = redact(output)
  return { code, output: clean, outputs: parseOutputs(clean) }
}
