import type { DeviceTarget } from '../devices'
import type { SetId, Size, Store } from './sizes'
import type { ExportResult, FullStyle, PageBrand, PageFont, Project } from './types'

/**
 * The contract between `kit shots studio`'s server (`studio-server.ts`) and the editor (`editor/`).
 * Types only, and type imports only: the browser editor imports this file.
 *
 * The server listens on `127.0.0.1`; every route sits under a random path token and is relative to
 * the page URL (`http://127.0.0.1:<port>/<token>/`). Responses carry `cache-control: no-store`.
 * A failed request answers with a `StudioError` body and the status in the table.
 *
 * | Route | Request | Response |
 * | --- | --- | --- |
 * | `GET ./`, `GET assets/*` | | The built editor |
 * | `GET api/session` | | `StudioSession` |
 * | `GET api/project` | | `StudioProjectFile`; 404 when there is no project file yet |
 * | `PUT api/project` | `StudioSave` | `StudioSaved`; 409 the file changed on disk since `hash`; 422 invalid, `issues` set |
 * | `GET api/shots` | | `StudioShots` |
 * | `GET api/shot/<target>/<path>` | | The raw PNG; `<path>` is a `StudioShot.path`, each segment URL-encoded |
 * | `POST api/shot/<target>/<name>` | PNG bytes | `StudioShot`; 409 the file exists (add `?replace=1`); 422 not a PNG or a bad name |
 * | `GET api/asset/<n>` | | A font or the brand mark (`StudioSession.fonts[].url`, `brand.mark`) |
 * | `POST api/export` | `StudioExportRequest` | `ExportResult`; 422 with the KitError message when export fails |
 */

/** What the editor needs to know about the repo, read once at start. */
export interface StudioSession {
  /** The project file (`shots.project`), relative to the repo root. */
  projectPath: string
  /** The raw dir, relative to the repo root. */
  rawPath: string
  targets: readonly DeviceTarget[]
  /** The export size of each target (`shots.sets`, with defaults). */
  sets: Record<DeviceTarget, { id: SetId; store: Store } & Size>
  /** Locales found in each store's metadata dir; `['en-US']` when there are none. */
  locales: Record<Store, string[]>
  /** `shots.fonts`, with `url` pointing at `api/asset/<n>`. */
  fonts: PageFont[]
  /** `shots.brand`, with `mark` pointing at `api/asset/<n>`; `null` when the config sets none. */
  brand: PageBrand | null
  /** kit's built-in style: the bottom layer of the merge. */
  builtIn: FullStyle
}

/** The project file as it is on disk. */
export interface StudioProjectFile {
  /** The parsed file. The editor edits a version 2 project only; a version 1 one is shown read-only. */
  project: Project
  /** Opaque hash of the file's bytes; sent back with a save to detect a change on disk. */
  hash: string
}

export interface StudioSave {
  project: Project
  /** The `hash` the project was loaded or last saved with; `null` creates the file and fails with 409 if one exists. */
  hash: string | null
}

export interface StudioSaved {
  /** Hash of the bytes just written. */
  hash: string
}

/** One raw shot. */
export interface StudioShot {
  /** File name (`01-home.png`): what a slide's `shot` names. */
  file: string
  /** Path under `<raw>/<target>/`, `/`-separated: `01-home.png` or `fr-FR/01-home.png`. */
  path: string
  /** The locale dir the shot sits in; absent for the target's base shots. */
  locale?: string
  width: number
  height: number
}

export type StudioShots = Record<DeviceTarget, StudioShot[]>

export interface StudioExportRequest {
  stores: Store[]
  /** Only these locales; absent exports every locale of each store. */
  locales?: string[]
}

export type StudioExportResult = ExportResult

export interface StudioError {
  error: string
  /** Set on a 422 from `PUT api/project`: one line per bad field, `path: message`. */
  issues?: string[]
}
