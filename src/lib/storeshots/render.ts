import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interrupted, onCleanup, trackChild } from '../cleanup'
import { ExitCode, KitError } from '../errors'
import { flattenPng, imageInfo } from '../image/png'
import { spawnDetached } from '../proc'
import { serveShots } from './server'
import type { Job, RenderJobs } from './types'

/**
 * The render host: serves the plan, runs headless Chrome on it, and hands back one checked PNG
 * per job. The page protocol is documented at `PagePlan` in `types.ts`.
 */

export const RENDER_TIMEOUT_MS = 5 * 60_000

/** What an exported PNG with alpha is flattened onto. */
const FLATTEN_BACKGROUND = '#ffffff'

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** The Chrome command line for one render: a throwaway profile, then the page URL last. */
export function chromeArgv(chrome: string, profile: string, url: string): string[] {
  return [
    chrome,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    url,
  ]
}

function duration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}

function logTail(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8').trim().split('\n').slice(-5).join('\n') || undefined
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The job's PNG, checked against the job's size and without alpha. */
function checked(job: Job, bytes: Uint8Array | undefined): Uint8Array {
  if (bytes === undefined) throw new KitError(`The page sent no PNG for ${job.id}`)
  let info: ReturnType<typeof imageInfo>
  try {
    info = imageInfo(bytes)
  } catch (e) {
    throw new KitError(`The page sent a bad PNG for ${job.id}: ${reason(e)}`)
  }
  if (info.format !== 'png') throw new KitError(`The page sent a ${info.format} image for ${job.id}, not a PNG`)
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

export const renderJobs: RenderJobs = async (plan, opts) => {
  if (plan.jobs.length === 0) return new Map()
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS

  // The profile gets its own dir so Chrome's log can sit beside it, not in it.
  const work = mkdtempSync(join(tmpdir(), 'kit-shots-'))
  const profile = join(work, 'profile')
  const chromeLog = join(work, 'chrome.log')
  const server = serveShots(plan, { page: opts.page })

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
      rmSync(work, { recursive: true, force: true, maxRetries: 3 })
    })()
    return disposed
  }
  const off = onCleanup(dispose)

  // lib/cleanup forwards the signal to Chrome and waits for it; a Chrome that ignores it must not
  // hold kit until the timeout.
  const { promise: stopped, resolve: stop } = Promise.withResolvers<'stopped'>()
  const onSignal = (): void => stop('stopped')
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    mkdirSync(profile)
    chrome = spawnDetached(chromeArgv(opts.chrome, profile, server.url), chromeLog)
    trackChild(chrome, true)

    let finished = false
    const done = server.done.then((result) => {
      finished = true
      return result
    })
    const outcome = await Promise.race([
      done,
      chrome.exited.then((code) => ({ exited: code })),
      stopped,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])

    // A page that posts `done` and a Chrome that exits right after are one outcome: the page's.
    const result = finished ? await done : outcome
    if (result === 'stopped' || interrupted()) {
      throw new KitError('Interrupted', undefined, ExitCode.interrupted)
    }
    if (result === 'timeout') {
      throw new KitError(
        `Chrome did not finish rendering within ${duration(timeoutMs)}`,
        `${server.images.size} of ${plan.jobs.length} images came back`,
      )
    }
    if ('exited' in result) {
      throw new KitError(
        `Chrome exited (code ${result.exited}) before the page finished`,
        logTail(chromeLog) ?? `Ran ${opts.chrome}`,
      )
    }
    if (!result.ok) throw new KitError(`The shots page failed: ${result.error ?? 'no error given'}`)

    const images = new Map<string, Uint8Array>()
    for (const job of plan.jobs) images.set(job.id, checked(job, server.images.get(job.id)))
    return images
  } finally {
    clearTimeout(timer)
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal)
    off()
    await dispose()
  }
}
