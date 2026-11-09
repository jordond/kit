import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

const LOCKFILES: [string, PackageManager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

/** Package manager for `dir`: the nearest lockfile walking up to `root`. Defaults to bun. */
export function detectPackageManager(dir: string, root: string): PackageManager {
  let d = resolve(dir)
  const stop = resolve(root)
  while (true) {
    for (const [file, pm] of LOCKFILES) if (existsSync(join(d, file))) return pm
    if (d === stop) return 'bun'
    const parent = dirname(d)
    if (parent === d) return 'bun'
    d = parent
  }
}

export const runScript = (pm: PackageManager, script: string): string[] => [pm, 'run', script]

/** Run a binary from node_modules (`bun x`, `pnpm exec`, …). */
export function pmExec(pm: PackageManager, bin: string, ...args: string[]): string[] {
  switch (pm) {
    case 'bun':
      return ['bun', 'x', bin, ...args]
    case 'pnpm':
      return ['pnpm', 'exec', bin, ...args]
    case 'yarn':
      return ['yarn', bin, ...args]
    case 'npm':
      return ['npx', '--no-install', bin, ...args]
  }
}

/** Scripts in `<dir>/package.json`, or undefined when there is none. */
export function packageScripts(dir: string): Record<string, string> | undefined {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    return (JSON.parse(readFileSync(file, 'utf8')).scripts ?? {}) as Record<string, string>
  } catch {
    return undefined
  }
}
