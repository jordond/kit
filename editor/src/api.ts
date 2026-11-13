import type { DeviceTarget } from '../../src/lib/devices'
import type {
  StudioError,
  StudioExportRequest,
  StudioExportResult,
  StudioProjectFile,
  StudioSave,
  StudioSaved,
  StudioSession,
  StudioShot,
  StudioShots,
} from '../../src/lib/storeshots/studio-api'

/**
 * Typed client for the routes in `src/lib/storeshots/studio-api.ts`. Every URL is relative to the
 * page (`document.baseURI`): the server puts the whole app under a random path token, and the dev
 * server proxies `/api` to it.
 */

/** A route's URL, resolved against the page. */
export const apiUrl = (path: string): string => new URL(path, document.baseURI).href

/** A request the server answered with an error status, or that never reached it (`status` 0). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** One line per bad field, on a 422 from `PUT api/project`. */
    readonly issues?: string[],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), init)
  } catch (err) {
    throw new ApiError(
      `Could not reach the kit server: ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }
  if (res.ok) return res
  let body: Partial<StudioError> = {}
  try {
    body = (await res.json()) as Partial<StudioError>
  } catch {
    // Not JSON: the status line is all there is.
  }
  throw new ApiError(body.error ?? `${res.status} ${res.statusText}`.trim(), res.status, body.issues)
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await request(path, init)).json()) as T
}

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Each segment of a `/`-separated path URL-encoded, the `/` kept. */
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/')

export const getSession = (): Promise<StudioSession> => json('api/session')

/** The project file, or `null` when there is none yet (404). Any other failure throws. */
export async function getProject(): Promise<StudioProjectFile | null> {
  try {
    return await json<StudioProjectFile>('api/project')
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

/** Throws `ApiError` 409 when the file changed on disk, 422 with `issues` when the project is invalid. */
export const putProject = (save: StudioSave): Promise<StudioSaved> =>
  json('api/project', jsonBody('PUT', save))

export const getShots = (): Promise<StudioShots> => json('api/shots')

/** URL of a raw shot's PNG. */
export const shotUrl = (target: DeviceTarget, shot: Pick<StudioShot, 'path'>): string =>
  apiUrl(`api/shot/${encodeURIComponent(target)}/${encodePath(shot.path)}`)

/** Uploads a PNG into the target's raw dir; throws `ApiError` 409 when it exists and `replace` is not set. */
export const uploadShot = (
  target: DeviceTarget,
  name: string,
  png: Blob,
  options: { replace?: boolean } = {},
): Promise<StudioShot> =>
  json(
    `api/shot/${encodeURIComponent(target)}/${encodeURIComponent(name)}${options.replace ? '?replace=1' : ''}`,
    { method: 'POST', headers: { 'content-type': 'image/png' }, body: png },
  )

/** URL of a font or the brand mark: a `StudioSession.fonts[].url` or `brand.mark`. */
export const assetUrl = (url: string): string =>
  // The contract says `api/asset/<n>`, but the server hands out the export page's `asset/<n>`
  // (`pageAssets`), which its router does not serve: accept both.
  apiUrl(url.startsWith('asset/') ? `api/${url}` : url)

export const exportShots = (req: StudioExportRequest): Promise<StudioExportResult> =>
  json('api/export', jsonBody('POST', req))
