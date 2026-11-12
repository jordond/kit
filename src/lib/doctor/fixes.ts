import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isVersion, repinWorkflow, tagSha } from '../kitref'
import { runQuiet } from '../proc'
import { readXcconfig, setModuleVersion, setXcconfigVersion } from '../release/version'

/**
 * `kit doctor --fix`: what a check can repair by itself (./repair.ts runs them). Only safe, local repairs: a command in
 * the repo (`lefthook install`, `mise install`, the package manager's install, `chmod +x`) or a
 * small in-process edit (the version files, the workflow pins). Tools, logins, `.env` values and
 * secrets are never fixed; their checks keep a hint.
 */

/** A command (`cwd` repo-relative; default the root), or an edit that returns why it changed nothing. */
export type FixAction =
  | { cmd: string[]; cwd?: string }
  | { edit: () => string | undefined | Promise<string | undefined> }

export interface Fix {
  description: string
  action: FixAction
  /** Other check ids to run again after the fix; the fixed check always is. */
  rechecks?: string[]
  /** What to do when the fix ran and the check still does not pass (default: the check's hint). */
  after?: string
}

export interface FixResult {
  id: string
  description: string
  /** False when nothing was changed: a dry run, no confirmation, or the fix skipped itself. */
  applied: boolean
  /** The check passes after the fix (a dry run: nothing went wrong). */
  ok: boolean
  error?: string
  /** The next step when the fix was applied and the check still does not pass. */
  hint?: string
}

/** What `--json` shows of a fix: its description, and the command when it is one. */
export function describeFix(fix: Fix): { description: string; cmd?: string[]; cwd?: string } {
  return 'cmd' in fix.action
    ? { description: fix.description, cmd: fix.action.cmd, cwd: fix.action.cwd ?? '.' }
    : { description: fix.description }
}

/** Checks that are not ok and carry a fix, in report order. */
export function fixable<C extends { status: string; fix?: Fix }>(checks: C[]): (C & { fix: Fix })[] {
  return checks.filter((c): c is C & { fix: Fix } => (c.status === 'warn' || c.status === 'fail') && !!c.fix)
}

const lastLine = (output: string) => output.trim().split('\n').pop()?.trim() ?? ''

/** Run one fix. Never throws: a failure comes back as `ok: false` with the reason. */
export async function applyFix(root: string, id: string, fix: Fix): Promise<FixResult> {
  const base = { id, description: fix.description }
  try {
    if ('cmd' in fix.action) {
      const { cmd, cwd } = fix.action
      if (!Bun.which(cmd[0]!, { PATH: process.env.PATH }))
        return { ...base, applied: false, ok: false, error: `${cmd[0]} not found` }
      const r = await runQuiet(cmd, { cwd: join(root, cwd ?? '.') })
      if (r.code === 0) return { ...base, applied: true, ok: true }
      const why = lastLine(r.output)
      return { ...base, applied: true, ok: false, error: `exit ${r.code}${why ? `: ${why}` : ''}` }
    }
    const skipped = await fix.action.edit()
    if (skipped !== undefined) return { ...base, applied: false, ok: false, error: skipped }
    return { ...base, applied: true, ok: true }
  } catch (e) {
    return { ...base, applied: true, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** The xcconfig's MARKETING_VERSION set to the TOML version (what `kit version bump` writes). */
export function iosVersionFix(root: string, drift: { toml: string; file: string }): Fix {
  return {
    description: `set MARKETING_VERSION = ${drift.toml} in ${drift.file}`,
    action: {
      edit: () => {
        const before = readXcconfig(root, drift.file)
        writeFileSync(join(root, drift.file), setXcconfigVersion(before, drift.file, drift.toml))
        return undefined
      },
    },
  }
}

/** The app module's `settings.android.versionName` set to the TOML version. */
export function androidVersionFix(root: string, drift: { toml: string; file: string }): Fix {
  return {
    description: `set settings.android.versionName: "${drift.toml}" in ${drift.file}`,
    action: {
      edit: () => {
        const path = join(root, drift.file)
        writeFileSync(path, setModuleVersion(readFileSync(path, 'utf8'), drift.file, drift.toml))
        return undefined
      },
    },
  }
}

/** The plain version of an npm range (`^0.6.0` → `0.6.0`); undefined for `file:`, `workspace:`, a tag. */
export function pinVersion(pin: string | undefined): string | undefined {
  const v = pin?.replace(/^[\^~=v]+/, '')
  return v && isVersion(v) ? v : undefined
}

/**
 * Workflow pins moved to the npm pin's version, as `kit upgrade` does. The release's tag commit
 * comes from the kit repo; offline (or before the tag exists) nothing is written.
 */
export function ciPinFix(
  root: string,
  version: string,
  resolveSha: (version: string) => Promise<string | undefined> = tagSha,
): Fix {
  return {
    description: `move the workflow pins to v${version}`,
    action: {
      edit: async () => {
        const sha = await resolveSha(version)
        if (!sha) return `v${version} not found in the kit repo (offline?): workflow pins left as they are`
        const dir = join(root, '.github/workflows')
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : []
        for (const f of files.sort()) {
          const text = readFileSync(join(dir, f), 'utf8')
          const next = repinWorkflow(text, version, sha)
          if (next.count > 0) writeFileSync(join(dir, f), next.text)
        }
        return undefined
      },
    },
  }
}
