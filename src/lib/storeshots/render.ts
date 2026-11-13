import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHROME_HINT } from '../chrome'
import { interrupted, onCleanup, trackChild } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { flattenPng, imageInfo } from '../image/png'
import { spawnDetached } from '../proc'
import { repoPath } from './plan'
import { serveShots } from './server'
import type { Job, PageDone, RenderJobs } from './types'

/**
 * The render host: serves the plan, runs headless Chrome on it, and hands back one checked PNG
 * per job. The page protocol is documented at `PagePlan` in `types.ts`.
 */

/** How long the page may go without posting a new image before the run is given up. */
export const RENDER_TIMEOUT_MS = 5 * 60_000

/** The file in the work dir that Chrome is started on: it sends Chrome on to the server URL. */
export const OPENER_FILE = 'open.html'

/** What an exported PNG with alpha is flattened onto. */
const FLATTEN_BACKGROUND = '#ffffff'

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * The document Chrome is started on. The server URL carries the path token, and a command line is
 * readable by every local user through `ps`; so the URL goes into this file in the 0700 work dir,
 * and Chrome's argv names only the file.
 */
export function openerHtml(url: string): string {
  // `<` cannot end the script early: JSON leaves it as is, so it is escaped here.
  const target = JSON.stringify(url).replace(/</g, '\\u003c')
  return `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>kit shots export</title>
<script>location.replace(${target})</script>
`
}

/** The server URL an opener file sends Chrome to; undefined when `html` is not one. */
export function openerTarget(html: string): string | undefined {
  const target = /location\.replace\((".*")\)<\/script>/.exec(html)?.[1]
  return target === undefined ? undefined : (JSON.parse(target) as string)
}

/** The Chrome command line for one render: a throwaway profile, any `extra` flags, then the URL to open last. */
export function chromeArgv(chrome: string, profile: string, url: string, extra: readonly string[] = []): string[] {
  return [
    chrome,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    ...extra,
    url,
  ]
}

export function duration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}

export function logTail(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8').trim().split('\n').slice(-5).join('\n') || undefined
}

export const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The job's PNG, checked against the job's size and without alpha. */
function checked(job: Job, bytes: Uint8Array | undefined): Uint8Array {
  if (bytes === undefined) throw new KitError(`The page sent no PNG for ${job.id}`)
  let info: ReturnType<typeof imageInfo>
  try {
    info = imageInfo(bytes)
  } catch (e) {
    throw new KitError(`The page sent a bad PNG for ${job.id}: ${reason(e)}`)
  }
  if (info.format !== 'png') {
    throw new KitError(`The page sent a ${info.format} image for ${job.id}, not a PNG`)
  }
  if (info.width !== job.width || info.height !== job.height) {
    throw new KitError(
      `The PNG for ${job.id} is ${info.width}x${info.height}`,
      `The ${job.set} set is ${job.width}x${job.height}`,
    )
  }
  if (!info.alpha) return bytes
  try {
    return flattenPng(bytes, FLATTEN_BACKGROUND)
  } catch (e) {
    throw new KitError(`Cannot flatten the PNG for ${job.id}: ${reason(e)}`)
  }
}

/** A page failure, naming the raw shot of the job it happened on: the job id alone says little. */
function pageFailure(jobs: readonly Job[], result: PageDone, root: string | undefined): KitError {
  const error = result.error ?? 'no error given'
  const job = jobs.find((j) => j.id === result.job)
  if (!job) return new KitError(`The shots page failed: ${error}`)
  const shot = root === undefined ? job.shot : repoPath(root, job.shot)
  return new KitError(
    `The shots page failed on ${job.id}: ${error}`,
    `Its raw shot is ${shot}, for slide "${job.slide.name}" (${job.slide.id})`,
  )
}

export const renderJobs: RenderJobs = async (plan, opts) => {
  if (plan.jobs.length === 0) return new Map()
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS

  // The profile gets its own dir so Chrome's log and the opener can sit beside it, not in it.
  // mkdtemp makes the dir 0700: nobody else reads the opener, which holds the server URL.
  const work = mkdtempSync(join(tmpdir(), 'kit-shots-'))
  const profile = join(work, 'profile')
  const chromeLog = join(work, 'chrome.log')
  const opener = join(work, OPENER_FILE)

  // An idle timeout: the clock restarts with every new image, so a long plan on a slow machine is
  // fine as long as it keeps moving. A job posted again is not progress: a page that re-posts one
  // job forever must still run out of time.
  let timer: ReturnType<typeof setTimeout> | undefined
  const { promise: idle, resolve: timeUp } = Promise.withResolvers<'timeout'>()
  let settled = false
  const restartClock = (): void => {
    clearTimeout(timer)
    // An image posted while the run is being torn down must not leave a timer holding kit open.
    if (!settled) timer = setTimeout(() => timeUp('timeout'), timeoutMs)
  }
  const received = new Set<string>()
  const onImage = (jobId: string): void => {
    if (received.has(jobId)) return
    received.add(jobId)
    restartClock()
  }
  const server = serveShots(plan, { page: opts.page, onImage })

  let chrome: Bun.Subprocess | undefined
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposed ??= (async () => {
      if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
        try {
          // Chrome runs as its own process group: renderers, the GPU and crashpad helpers go with it.
          process.kill(-chrome.pid, 'SIGKILL')
        } catch {
          chrome.kill('SIGKILL')
        }
        await chrome.exited
      }
      await server.stop()
      try {
        rmSync(work, { recursive: true, force: true, maxRetries: 3 })
      } catch (e) {
        // A temp dir left behind is not worth the render: the images are already in memory.
        opts.verbose?.(`Could not remove ${work}: ${reason(e)}`)
      }
    })()
    return disposed
  }
  const off = onCleanup(dispose)

  // lib/cleanup forwards the signal to Chrome and waits for it; a Chrome that ignores it must not
  // hold kit until the timeout.
  const { promise: stopped, resolve: stop } = Promise.withResolvers<'stopped'>()
  const onSignal = (): void => stop('stopped')
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal)

  try {
    mkdirSync(profile)
    writeFileSync(opener, openerHtml(server.url), { mode: 0o600 })
    try {
      chrome = spawnDetached(chromeArgv(opts.chrome, profile, pathToFileURL(opener).href), chromeLog)
    } catch (e) {
      // Only the spawn itself: any other failure of the run is not a Chrome that cannot start.
      throw new KitError(
        `Cannot start Chrome at ${opts.chrome}: ${reason(e)}`,
        CHROME_HINT,
        ExitCode.precondition,
      )
    }
    trackChild(chrome, true)
    restartClock()

    let finished = false
    const done = server.done.then((result) => {
      finished = true
      return result
    })
    const outcome = await Promise.race([
      done,
      chrome.exited.then((code) => ({ exited: code })),
      stopped,
      idle,
    ])

    // A page that posts `done` and a Chrome that exits right after are one outcome: the page's.
    const result = finished ? await done : outcome
    if (result === 'stopped' || interrupted()) {
      throw new KitError('Interrupted', undefined, ExitCode.interrupted)
    }
    if (result === 'timeout') {
      throw new KitError(
        `Chrome did not finish rendering: no new image came back for ${duration(timeoutMs)}`,
        `${server.images.size} of ${plan.jobs.length} images came back before that`,
      )
    }
    if ('exited' in result) {
      throw new KitError(
        `Chrome exited (code ${result.exited}) before the page finished`,
        logTail(chromeLog) ?? `Ran ${opts.chrome}`,
      )
    }
    if (!result.ok) throw pageFailure(plan.jobs, result, opts.root)

    const images = new Map<string, Uint8Array>()
    for (const job of plan.jobs) images.set(job.id, checked(job, server.images.get(job.id)))
    return images
  } finally {
    settled = true
    clearTimeout(timer)
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal)
    off()
    await dispose()
  }
}
