/**
 * A fake Chrome for `kit shots export` tests: it plays the page's side of the protocol documented
 * at `PagePlan` in `src/lib/storeshots/types.ts`, without a browser.
 *
 * `fakeChrome(dir)` writes an executable to `dir` (use it as `KIT_CHROME` or `RenderOptions.chrome`)
 * and reads back what it was called with. Each run appends its argv as one JSON line to the log,
 * takes the page URL from its last argument, fetches `plan.json`, posts one solid-colour PNG per
 * job at the job's size (`encodePng`) to `out/<jobId>`, posts `done` and exits 0.
 * `--version` prints a Chrome version line and exits.
 *
 * Env switches, read by the fake at run time (set them in the env of whatever spawns it):
 *
 * | Variable | Effect |
 * | --- | --- |
 * | `FAKE_CHROME=wrong-size` | The first job's PNG is one pixel too wide |
 * | `FAKE_CHROME=rgba` | Every PNG is RGBA, half transparent |
 * | `FAKE_CHROME=missing` | The first job's PNG is never posted; `done` is still `{ ok: true }` |
 * | `FAKE_CHROME=error` | Posts no PNG, then `done` with `{ ok: false, error: 'fake page error' }` |
 * | `FAKE_CHROME=exit` | Exits 3 without a request, printing `fake chrome crashed` to stderr |
 * | `FAKE_CHROME=hang` | Makes no request and never exits |
 * | `FAKE_CHROME_VERSION` | The version `--version` prints; default `131.0.6778.86` |
 * | `FAKE_CHROME_LOG` | The argv log; the executable `fakeChrome` writes sets it |
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from '../../src/lib/image/png'
import type { PageDone, PagePlan } from '../../src/lib/storeshots/types'

export type FakeChromeMode = 'wrong-size' | 'rgba' | 'missing' | 'error' | 'exit' | 'hang'

export interface FakeChrome {
  /** The executable: `KIT_CHROME`, or `RenderOptions.chrome`. */
  bin: string
  /** The argv log (`FAKE_CHROME_LOG`). */
  log: string
  /** The argv of each run, in order, without the executable itself. */
  calls(): string[][]
}

/** The colour of every pixel the fake posts; in `rgba` mode at `FAKE_ALPHA`. */
export const FAKE_RGB = [70, 41, 27] as const
export const FAKE_ALPHA = 128

/** Write the fake Chrome executable and its (empty) argv log to `dir`. */
export function fakeChrome(dir: string): FakeChrome {
  const bin = join(dir, 'fake-chrome')
  const log = join(dir, 'fake-chrome.log')
  writeFileSync(log, '')
  writeFileSync(
    bin,
    `#!/bin/sh
FAKE_CHROME_LOG='${log}' exec '${process.execPath}' --no-env-file '${import.meta.path}' "$@"
`,
  )
  chmodSync(bin, 0o755)
  return {
    bin,
    log,
    calls() {
      if (!existsSync(log)) return []
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
    },
  }
}

function png(width: number, height: number, rgba: boolean): Uint8Array {
  const channels = rgba ? 4 : 3
  const pixels = new Uint8Array(width * height * channels)
  for (let at = 0; at < pixels.length; at += channels) {
    pixels.set(FAKE_RGB, at)
    if (rgba) pixels[at + 3] = FAKE_ALPHA
  }
  return encodePng(width, height, pixels)
}

async function post(url: string, body: Uint8Array | string): Promise<void> {
  const res = await fetch(url, { method: 'POST', body })
  if (!res.ok) throw new Error(`POST ${url} answered ${res.status}`)
}

async function main(argv: string[]): Promise<number> {
  const log = process.env.FAKE_CHROME_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ argv })}\n`)
  if (argv.includes('--version')) {
    console.log(`Google Chrome ${process.env.FAKE_CHROME_VERSION ?? '131.0.6778.86'}`)
    return 0
  }

  const mode = process.env.FAKE_CHROME
  if (mode === 'exit') {
    console.error('fake chrome crashed')
    return 3
  }
  if (mode === 'hang') {
    setInterval(() => {}, 60_000)
    return await new Promise<number>(() => {})
  }

  const base = argv.at(-1)
  if (!base?.startsWith('http://')) {
    console.error('fake chrome: the last argument is not a URL')
    return 2
  }
  const done = (body: PageDone): Promise<void> => post(new URL('done', base).href, JSON.stringify(body))
  if (mode === 'error') {
    await done({ ok: false, error: 'fake page error' })
    return 0
  }

  const res = await fetch(new URL('plan.json', base))
  if (!res.ok) throw new Error(`GET plan.json answered ${res.status}`)
  const plan = (await res.json()) as PagePlan
  for (const [i, job] of plan.jobs.entries()) {
    if (mode === 'missing' && i === 0) continue
    const width = mode === 'wrong-size' && i === 0 ? job.width + 1 : job.width
    await post(new URL(`out/${job.id}`, base).href, png(width, job.height, mode === 'rgba'))
  }
  await done({ ok: true })
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
