import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installDir } from '../config/load'
import { KIT_PACKAGE } from './kitref'

/**
 * Which kit should run in a repo. The launcher (`bin/kit`) hands off to the repo's own copy, but a
 * launcher only knows the layouts of its own release: a global kit older than the repo's can miss
 * the repo copy and run itself. These checks catch that from the JS side.
 */

/** The repo's kit: where it is pinned and, when installed, what is there. */
export interface RepoKit {
  /** The manifest that pins kit, relative to the repo root (`package.json`, `.kit/package.json`). */
  manifest: string
  /** The dependency range in the manifest (`^0.7.1`); absent when the manifest does not name kit. */
  range?: string
  /** The installed copy; absent when the install has not been run. */
  installed?: { dir: string; version: string; cli: string }
}

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** The pin and the installed copy of kit in `root`; undefined when the repo has no manifest. */
export function repoKit(root: string): RepoKit | undefined {
  const dir = installDir(root)
  const manifest = join(dir, 'package.json')
  const pkg = readJson(join(root, manifest))
  if (!pkg) return undefined
  const range = (['devDependencies', 'dependencies'] as const)
    .map((key) => (pkg[key] as Record<string, unknown> | undefined)?.[KIT_PACKAGE])
    .find((v): v is string => typeof v === 'string')
  const copy = join(root, dir, 'node_modules', KIT_PACKAGE)
  const version = readJson(join(copy, 'package.json'))?.version
  const cli = join(copy, 'dist', 'cli.js')
  return {
    manifest,
    ...(range === undefined ? {} : { range }),
    ...(typeof version === 'string' && existsSync(cli) ? { installed: { dir: copy, version, cli } } : {}),
  }
}

/** A range kit can judge: a version with an optional `^`, `~` or comparison in front. */
const isSemverRange = (range: string): boolean => /^(?:[\^~]|[<>]=?|=)?\s*\d+\.\d+\.\d+/.test(range)

export type CopyVerdict =
  /** This copy is the right one to run. */
  | { kind: 'ok' }
  /** The repo has its own copy and this is not it: run that one. */
  | { kind: 'handoff'; cli: string; version: string }
  /** The repo pins a kit this copy does not satisfy, and the repo copy is not installed. */
  | { kind: 'mismatch'; range: string; manifest: string }

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether the kit at `ownDir` (version `ownVersion`) is the one that should run in `root`.
 * `satisfies` is `Bun.semver.satisfies`; a range that is not a plain version range (`workspace:*`,
 * `link:…`, a tag) is not judged.
 */
export function copyVerdict(
  root: string,
  own: { dir: string; version: string },
  satisfies: (version: string, range: string) => boolean = Bun.semver.satisfies,
): CopyVerdict {
  const repo = repoKit(root)
  if (!repo) return { kind: 'ok' }
  if (repo.installed) {
    return real(repo.installed.dir) === real(own.dir)
      ? { kind: 'ok' }
      : { kind: 'handoff', cli: repo.installed.cli, version: repo.installed.version }
  }
  if (repo.range !== undefined && isSemverRange(repo.range) && !satisfies(own.version, repo.range)) {
    return { kind: 'mismatch', range: repo.range, manifest: repo.manifest }
  }
  return { kind: 'ok' }
}

/** The package root of the kit that holds `from` (a file or dir inside it), with its version. */
export function kitCopyAt(from: string): { dir: string; version: string } | undefined {
  let dir = from
  while (true) {
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg?.name === KIT_PACKAGE && typeof pkg.version === 'string') return { dir, version: pkg.version }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The kit a `kit` on PATH would start outside a repo: the launcher's own package. */
export function pathKit(
  which: (bin: string) => string | null = Bun.which,
): { dir: string; version: string } | undefined {
  const bin = which('kit')
  return bin ? kitCopyAt(dirname(real(bin))) : undefined
}

/** Numeric compare of two `X.Y.Z` versions: negative when `a` is older. */
export const compareVersions = (a: string, b: string): number => Bun.semver.order(a, b)
