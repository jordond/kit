import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { ExitCode, KitError } from './errors'
import type { Env } from './proc'

/** The oldest Chrome major with `--headless=new`, which `kit shots export` runs. */
export const CHROME_MIN_MAJOR = 112

/** Env vars that name the browser, in order; a set one is final (no fallback to an installed Chrome). */
export const CHROME_ENV = ['KIT_CHROME', 'CHROME_PATH'] as const

const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
] as const

const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'] as const

export const CHROME_HINT = 'Install Google Chrome, or set KIT_CHROME to a Chrome or Chromium binary'

/**
 * The Chrome or Chromium binary, or undefined when there is none.
 *
 * Order: `KIT_CHROME`, `CHROME_PATH` (a path, or a command name looked up on PATH), the macOS app
 * bundles (`/Applications` Chrome, `~/Applications` Chrome, `/Applications` Chromium), then PATH
 * (`google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`). A set `KIT_CHROME` or
 * `CHROME_PATH` that names nothing gives undefined: kit does not swap in another browser.
 *
 * `env` supplies `KIT_CHROME`, `CHROME_PATH`, `PATH` and `HOME`; it defaults to the process env.
 */
export function findChrome(env: Env = process.env): string | undefined {
  for (const name of CHROME_ENV) {
    const value = env[name]
    if (!value) continue
    if (isAbsolute(value) || value.includes('/')) return existsSync(value) ? value : undefined
    return Bun.which(value, { PATH: env.PATH ?? '' }) ?? undefined
  }
  if (process.platform === 'darwin') {
    const [chrome, chromium] = MAC_APPS
    const candidates = [
      join('/Applications', chrome),
      join(env.HOME ?? homedir(), 'Applications', chrome),
      join('/Applications', chromium),
    ]
    const app = candidates.find((p) => existsSync(p))
    if (app) return app
  }
  for (const name of PATH_NAMES) {
    const found = Bun.which(name, { PATH: env.PATH ?? '' })
    if (found !== null) return found
  }
  return undefined
}

/** `findChrome()` for the process env, or a precondition failure (exit 4) with the install hint. */
export function chromeBin(): string {
  const bin = findChrome(process.env)
  if (bin !== undefined) return bin
  const named = CHROME_ENV.find((name) => process.env[name])
  throw new KitError(
    named ? `${named}=${process.env[named]} is not a Chrome binary` : 'Chrome not found',
    CHROME_HINT,
    ExitCode.precondition,
  )
}
