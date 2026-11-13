/**
 * A fake Chrome for `kit shots export` and `kit shots pages` tests: it plays the page's side of the protocol documented
 * at `PagePlan` in `src/lib/storeshots/types.ts`, without a browser.
 *
 * `fakeChrome(dir)` writes an executable to `dir` (use it as `KIT_CHROME` or `RenderOptions.chrome`)
 * and reads back what it was called with. Each run appends its argv, pid and page URL as one JSON
 * line to the log. Its last argument is the `file://` URL of the opener kit wrote (`openerHtml` in
 * `render.ts`); like Chrome it follows that file to the server URL, then fetches `plan.json`, posts
 * one solid-colour PNG per job at the job's size (`encodePng`) to `out/<jobId>`, posts `done` and
 * exits 0. `--version` prints a Chrome version line and exits.
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
 * | `FAKE_CHROME=slow` | Waits `FAKE_CHROME_DELAY_MS` (default 300) before each PNG and before `done` |
 * | `FAKE_CHROME=locked-profile` | Leaves a dir kit cannot remove in the profile, then runs as usual |
 * | `FAKE_CHROME=job-error` | Posts no PNG, then `done` with `{ ok: false, error: 'fake job error', job: <first job id> }` |
 * | `FAKE_CHROME_VERSION` | The version `--version` prints; default `131.0.6778.86` |
 * | `FAKE_CHROME_LOG` | The argv log; the executable `fakeChrome` writes sets it |
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng } from '../../src/lib/image/png'
import { openerTarget } from '../../src/lib/storeshots/render'
import type { PageDone, PagePlan } from '../../src/lib/storeshots/types'

export type FakeChromeMode =
  | 'wrong-size'
  | 'rgba'
  | 'missing'
  | 'error'
  | 'exit'
  | 'hang'
  | 'slow'
  | 'locked-profile'
  | 'job-error'

/** The dir `locked-profile` leaves in the profile: read-only, with a file in it. */
export const LOCKED_DIR = 'locked'

/** One run of the fake, as it logged itself. */
export interface FakeChromeRun {
  /** Without the executable itself. */
  argv: string[]
  pid: number
  /** The server URL the opener file led to; absent for `--version` and a last argument that is no opener. */
  url?: string
}

export interface FakeChrome {
  /** The executable: `KIT_CHROME`, or `RenderOptions.chrome`. */
  bin: string
  /** The argv log (`FAKE_CHROME_LOG`). */
  log: string
  /** The argv of each run, in order, without the executable itself. */
  calls(): string[][]
  /** Each run, in order. */
  runs(): FakeChromeRun[]
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
  const runs = (): FakeChromeRun[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeChromeRun)
      : []
  return { bin, log, runs, calls: () => runs().map((run) => run.argv) }
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
  const res = await fetch(url, { method: 'POST', body: body as BodyInit })
  if (!res.ok) throw new Error(`POST ${url} answered ${res.status}`)
}

/** The server URL behind the last argument: Chrome is handed the opener file, never the URL itself. */
function pageUrl(argv: string[]): string | undefined {
  const last = argv.at(-1)
  if (!last?.startsWith('file://')) return undefined
  const file = fileURLToPath(last)
  return existsSync(file) ? openerTarget(readFileSync(file, 'utf8')) : undefined
}

/**
 * `kit shots pages` mode (`--screenshot=<file>`): fetch the page from the server like Chrome would,
 * then write a PNG of `--window-size` times `--force-device-scale-factor`. `wrong-size`, `rgba` and
 * `missing` (writes no file) apply as for the export page; `exit` and `hang` are handled before.
 */
async function screenshot(argv: string[], base: string, file: string, mode: string | undefined): Promise<number> {
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const [w = 0, h = 0] = (flag('window-size') ?? '').split(',').map(Number)
  const scale = Number(flag('force-device-scale-factor') ?? 1)
  const res = await fetch(base)
  if (!res.ok) {
    console.error(`fake chrome: GET page answered ${res.status}`)
    return 1
  }
  if (mode === 'missing') return 0
  const width = w * scale + (mode === 'wrong-size' ? 1 : 0)
  writeFileSync(file, png(width, h * scale, mode === 'rgba'))
  return 0
}

async function main(argv: string[]): Promise<number> {
  const log = process.env.FAKE_CHROME_LOG
  const base = pageUrl(argv)
  if (log) appendFileSync(log, `${JSON.stringify({ argv, pid: process.pid, url: base })}\n`)
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

  const shot = argv.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length)
  if (shot !== undefined && base?.startsWith('http://')) return await screenshot(argv, base, shot, mode)

  if (!base?.startsWith('http://')) {
    console.error('fake chrome: the last argument is not an opener file that leads to a URL')
    return 2
  }
  if (mode === 'locked-profile') {
    const profile = argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
    if (profile === undefined) return 2
    const locked = join(profile, LOCKED_DIR)
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(locked, 'file'), '')
    chmodSync(locked, 0o500)
  }
  const delay = mode === 'slow' ? Number(process.env.FAKE_CHROME_DELAY_MS ?? 300) : 0
  const done = (body: PageDone): Promise<void> => post(new URL('done', base).href, JSON.stringify(body))
  if (mode === 'error') {
    await done({ ok: false, error: 'fake page error' })
    return 0
  }

  const res = await fetch(new URL('plan.json', base))
  if (!res.ok) throw new Error(`GET plan.json answered ${res.status}`)
  const plan = (await res.json()) as PagePlan
  if (mode === 'job-error') {
    await done({ ok: false, error: 'fake job error', job: plan.jobs[0]?.id })
    return 0
  }
  for (const [i, job] of plan.jobs.entries()) {
    if (mode === 'missing' && i === 0) continue
    if (delay) await Bun.sleep(delay)
    const width = mode === 'wrong-size' && i === 0 ? job.width + 1 : job.width
    await post(new URL(`out/${job.id}`, base).href, png(width, job.height, mode === 'rgba'))
  }
  if (delay) await Bun.sleep(delay)
  await done({ ok: true })
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
