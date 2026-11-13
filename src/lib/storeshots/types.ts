import type { KitContext } from '../../cli/command'
import type { KitConfig } from '../../config/schema'
import type { DeviceTarget } from '../devices'
import type { SetId, Store } from './sizes'
import type { ProjectV2 } from './types-v2'

/**
 * The contract of `kit shots export`. Every module under `lib/storeshots/` codes against these
 * types; the function types at the end are the exact signatures each module exports.
 *
 * Flow: `loadProject` reads the saved project; `planExport` (pure) turns config, project, raw shot
 * listing and destinations into an `ExportPlan`; `renderJobs` serves the plan to headless Chrome
 * and returns one PNG per job; `writeExport` puts them in the store dirs. `exportShots` wires them.
 *
 * Words: a **store** is `apple` or `google`; a **target** is the device a raw shot was taken on
 * (`ios`, `ipad`, `android`); a **set** is the named size a target is exported at (`iphone-6.9`);
 * a **slide** is one composed screenshot of the project; a **raw shot** is the PNG `kit shots`
 * captured; a **job** is one slide rendered for one set and locale.
 */

export type { SetId, Size, Store } from './sizes'
export type * from './types-v2'

// ---------------------------------------------------------------------------------------------
// The project file: version 1 is brewd's `studio.json` read as is, plus an optional `locales` block;
// version 2 (`types-v2.ts`) holds the rules once and `resolveSlides` expands it into version 1 slides.
// ---------------------------------------------------------------------------------------------

export type FrameType =
  | 'iphone-pro'
  | 'ipad-pro'
  | 'android-pixel'
  | 'clay-minimal'
  | 'frameless'
  | 'glass-card'

export type FrameColor =
  | 'titanium-natural'
  | 'titanium-black'
  | 'titanium-desert'
  | 'titanium-silver'
  | 'espresso'
  | 'cream'

export type DevicePosition = 'bottom-peek' | 'center-float' | 'top-peek' | 'angled-3d' | 'full-bleed'
export type ShadowElevation = 'none' | 'subtle' | 'medium' | 'deep' | 'dramatic'
export type BackgroundType = 'solid' | 'linear-gradient' | 'radial-gradient' | 'mesh-glow' | 'panorama'
export type BackgroundPattern = 'none' | 'coffee-beans' | 'warm-glow' | 'subtle-grid' | 'rings'
export type BadgeIcon = 'cup' | 'star' | 'sparkles' | 'map' | 'heart' | 'check' | 'none'
export type MascotPosition = 'top-center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface SlideBackground {
  type: BackgroundType
  primaryColor: string
  secondaryColor: string
  accentColor: string
  /** Degrees. */
  angle: number
  blur: number
  pattern: BackgroundPattern
  panoramaTotalSlides?: number
  panoramaSlideIndex?: number
}

export interface SlideText {
  id: string
  text: string
  fontFamily: string
  /** Percent of the base size (100 is the default). */
  fontSize: number
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  lineHeight: number
  /** In the file; the renderer does not read it. */
  letterSpacing: number
  /** In the file; the renderer does not read it. */
  yOffset: number
  shadow: boolean
  shadowColor: string
  shadowBlur: number
}

export interface SlideBadge {
  enabled: boolean
  text: string
  icon: BadgeIcon
  backgroundColor: string
  textColor: string
  borderColor: string
  /** Percent of the base size. */
  fontSize: number
}

export interface SlideDevice {
  frameType: FrameType
  color: FrameColor
  position: DevicePosition
  scale: number
  /** Percent of the canvas height. */
  yOffset: number
  /** Percent of the canvas width. */
  xOffset: number
  /** Degrees. */
  rotation: number
  /** Degrees. */
  perspectiveTilt: number
  shadowElevation: ShadowElevation
  shadowColor: string
  showReflection: boolean
  /** Screen corner radius in px of a 1320-wide canvas. */
  cornerRadius: number
}

/** One slide of the project (brewd's `ScreenshotSlide`). */
export interface Slide {
  /** Unique in the project; the key into `ProjectV1.locales[locale]`. */
  id: string
  /** Position in the exported set, ascending; ties keep file order. */
  order: number
  /** Human name; the `<slug>` of the exported file name comes from it. */
  name: string
  /** The editor's URL for the shot. kit never reads it: the raw shot is found through `sourceFile`. */
  imageSrc?: string
  /** File name of the raw shot (`home.png`), looked up under the raw dir. */
  sourceFile: string
  /** The target the slide was composed for. In a `Job` it equals `Job.target`. */
  platform: DeviceTarget
  badge: SlideBadge
  headline: SlideText
  subheadline: SlideText
  device: SlideDevice
  background: SlideBackground
  /** Draw the brand lockup (`PageBrand`) on this slide. */
  showMascot: boolean
  mascotPosition: MascotPosition
  customNotes?: string
}

/** Text that replaces a slide's base text in one locale; an absent field keeps the base text. */
export interface SlideLocaleText {
  headline?: string
  subheadline?: string
  badge?: string
}

/** The saved project, version 1: brewd's `StudioProjectState` plus `locales`. */
export interface ProjectV1 {
  version: 1
  platform: DeviceTarget
  /** The editor's size choice. kit ignores it and uses its own set sizes. */
  dimensionId?: string
  slides: Slide[]
  savedAt?: string
  /**
   * Localised text: locale code, then slide id. Lookup for a locale is the exact code (`fr-CA`),
   * then the first entry with the same language prefix (`fr`, `fr-FR`), then the slide's base text.
   */
  locales?: Record<string, Record<string, SlideLocaleText>>
}

/** A saved project of either version; `loadProject` returns one. */
export type Project = ProjectV1 | ProjectV2

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

/** One image to render and write: a slide, for one set of one store, in one locale. */
export interface Job {
  /**
   * Unique in the plan and safe as one URL path segment (`[A-Za-z0-9._-]+`):
   * `<target>-<locale>-<NN>`, e.g. `ios-en-US-01`. The page fetches `shot/<id>` and posts `out/<id>`.
   */
  id: string
  store: Store
  target: DeviceTarget
  set: SetId
  locale: string
  /** 1-based position in its (set, locale); the `NN` of the file name. */
  index: number
  /** Pixel size of the PNG: `SET_SIZES[set]`. */
  width: number
  height: number
  /**
   * The slide as the page draws it: text already localised, `platform` equal to `target`, and the
   * frame swapped to the target's own device when the slide used a platform frame. The page ignores
   * `imageSrc` and `sourceFile`.
   */
  slide: Slide
  /**
   * Absolute path of the raw shot: `<raw>/<target>/<locale>/<sourceFile>` when that exists, else
   * `<raw>/<target>/<sourceFile>`. Served as `shot/<id>`.
   */
  shot: string
  /**
   * Absolute path of the PNG to write.
   * apple: `<StoreDestination.dir>/<locale>/<NN>_<set>_<slug>.png`;
   * google: `<StoreDestination.dir>/<locale>/images/phoneScreenshots/<NN>_<slug>.png`.
   * `NN` is `index` zero-padded to two digits; `<slug>` is the slide name lower-cased with every
   * run of characters outside `[a-z0-9]` turned into one `-` and trimmed of `-` (the slide id when
   * that leaves nothing).
   */
  file: string
}

/** A slide left out of a set because its raw shot is absent (`--allow-missing`). */
export interface SkippedSlide {
  store: Store
  target: DeviceTarget
  set: SetId
  locale: string
  /** Slide id. */
  slide: string
  /** The raw shot that was looked for, relative to the repo root: `<raw>/<target>/<sourceFile>`. */
  shot: string
}

/** Where one store's screenshots go and which locales are exported. */
export interface StoreDestination {
  store: Store
  /**
   * Absolute dir holding one sub-dir per locale; `.kit-shots.json` (the manifest) sits in it.
   * apple: `<dirname(release.ios.metadata)>/screenshots`, or `<--out>/apple`;
   * google: `<release.android.metadata>`, or `<--out>/google`.
   */
  dir: string
  /**
   * Locales to export, after `--locale`: the locale dirs already in the store's metadata dir
   * (`release.ios.metadata`, `release.android.metadata`), or `['en-US']` when there are none.
   */
  locales: string[]
}

/** A font the page loads before the first draw (`shots.fonts`). */
export interface PageFont {
  family: string
  /** `asset/<n>`, relative to the page URL; `ExportPlan.assets[n]` is the file. */
  url: string
  /** A CSS weight or range (`'400 800'`). */
  weight?: string
}

/** The lockup drawn on a slide with `showMascot` (`shots.brand`). */
export interface PageBrand {
  /** `asset/<n>`, relative to the page URL: the mark image (svg or png). */
  mark: string
  /** The word beside the mark; absent draws the mark alone. */
  wordmark?: string
  /** Colour of the wordmark; default the slide's headline colour. */
  color?: string
  /** Font family of the wordmark; default the slide's headline family. */
  font?: string
}

/** Everything one `kit shots export` renders and writes. Built by `planExport`; plain data. */
export interface ExportPlan {
  /** The stores exported, in `STORES` order. */
  stores: Store[]
  /** One entry per store in `stores`, same order. */
  destinations: StoreDestination[]
  /** Ordered by store, target (`STORE_TARGETS` order), locale, then `index`. */
  jobs: Job[]
  /** Slides left out under `--allow-missing`; empty otherwise. */
  skipped: SkippedSlide[]
  /** `shots.fonts`, with `url` pointing into `assets`. */
  fonts: PageFont[]
  /** `shots.brand`, with `mark` pointing into `assets`; absent when the config sets none. */
  brand?: PageBrand
  /**
   * Absolute paths of the font and brand files: `GET asset/<n>` serves `assets[n]` with the
   * content type of its extension (woff2, ttf, otf, svg, png). Fonts first, in config order, then
   * the brand mark. `planExport` does not check that they exist; `exportShots` does (exit 4).
   */
  assets: string[]
}

// ---------------------------------------------------------------------------------------------
// The page protocol: what headless Chrome and the render host say to each other.
// ---------------------------------------------------------------------------------------------

/**
 * Chrome opens `http://127.0.0.1:<port>/<token>/`; every route below is relative to that URL, and
 * a request outside `/<token>/` is a 404.
 *
 * | Route | Body |
 * | --- | --- |
 * | `GET ./` | The HTML document: loads `page.js` as a module script |
 * | `GET page.js` | The page bundle (`pageBundle()`) |
 * | `GET plan.json` | A `PagePlan` |
 * | `GET shot/<jobId>` | The job's raw shot (`Job.shot`), `image/png` |
 * | `GET asset/<n>` | `ExportPlan.assets[n]` |
 * | `POST out/<jobId>` | Request body: the rendered PNG (`canvas.toBlob`, `image/png`) |
 * | `POST done` | Request body: a `PageDone` as JSON. The page posts it exactly once, last |
 *
 * The page loads every font (`FontFace.load()`, then `document.fonts.check()`), renders the jobs in
 * order, posts each PNG, then posts `done`. A font, shot or brand mark that fails to load, or any
 * thrown error, ends the run with `{ ok: false, error }`: the page never posts a slide without its shot.
 */
export interface PagePlan {
  fonts: PageFont[]
  /** `null` when the config sets no brand: a slide's `showMascot` then draws nothing. */
  brand: PageBrand | null
  jobs: PageJob[]
}

/** What the page needs of a `Job`. */
export type PageJob = Pick<Job, 'id' | 'width' | 'height' | 'slide'>

/** Body of `POST done`. */
export interface PageDone {
  ok: boolean
  /** Why the run failed; set when `ok` is false. */
  error?: string
  /** The `Job.id` the page was rendering when it failed; absent when the failure is not one job's. */
  job?: string
}

/** The `plan.json` the render host serves for a plan. */
export function pagePlan(plan: Pick<ExportPlan, 'fonts' | 'brand' | 'jobs'>): PagePlan {
  return {
    fonts: plan.fonts,
    brand: plan.brand ?? null,
    jobs: plan.jobs.map(({ id, width, height, slide }) => ({ id, width, height, slide })),
  }
}

// ---------------------------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------------------------

/** `kit shots export` flags, parsed. `--dry-run` and `--json` come from `ctx.flags`. */
export interface ExportOptions {
  /** `--store`, through `parseStores`. */
  stores: Store[]
  /** `--locale a,b`: only these locales; absent exports every locale of each store. */
  locales?: string[]
  /** `--out <dir>`, as given (relative to the repo root, or absolute). */
  out?: string
  /** `--allow-missing`: skip a slide whose raw shot is absent instead of failing (exit 4). */
  allowMissing: boolean
  /** `--force`: replace images in an owned set that the manifest does not list. */
  force: boolean
}

/** One image written (or, in a dry run, to be written). */
export interface WrittenShot {
  store: Store
  target: DeviceTarget
  set: SetId
  locale: string
  /** Slide id. */
  slide: string
  /** Relative to the repo root, `/`-separated; absolute when `--out` is outside the repo. */
  file: string
  width: number
  height: number
}

/** The `--json` document of `kit shots export`, and what a dry run reports. */
export interface ExportResult {
  dryRun: boolean
  stores: Store[]
  written: WrittenShot[]
  /** Files removed (or, in a dry run, to be removed) from the owned sets; same path form as `WrittenShot.file`. */
  removed: string[]
  skipped: SkippedSlide[]
}

/** What `planExport` reads. Everything from disk is passed in, so the function stays pure. */
export interface PlanInput {
  /** Absolute repo root. */
  root: string
  /** Read for `shots` (fonts, brand, sets); `shots` is set. */
  config: KitConfig
  project: Project
  /** One per exported store, `STORES` order, locales already narrowed by `--locale`. */
  destinations: StoreDestination[]
  /** Absolute raw dir: `shots.raw`, or the resolved `shots` suite's screenshots dir. */
  rawDir: string
  /**
   * The files under `rawDir`, as `/`-separated paths relative to it (`ios/home.png`,
   * `ios/fr-FR/home.png`). A slide whose shot is in neither place for its target is missing.
   */
  raw: ReadonlySet<string>
  /** `--allow-missing`. */
  allowMissing: boolean
}

export interface RenderOptions {
  /** The Chrome binary (`chromeBin()`). */
  chrome: string
  /** The page JS (`pageBundle()`), served as `page.js`. */
  page: string
  /**
   * Kill Chrome and fail (exit 1) when no image has come back for this long; default 5 minutes.
   * The clock restarts with every `out/<jobId>` the page posts, so it bounds one job, not the run.
   */
  timeoutMs?: number
  /** Absolute repo root: an error names a raw shot relative to it. Absent, the path is absolute. */
  root?: string
  /** Where `--verbose` detail goes (a temp dir that could not be removed); absent drops it. */
  verbose?: (message: string) => void
}

export interface WriteOptions {
  /** Absolute repo root: result paths are relative to it. */
  root: string
  /**
   * PNG bytes by job id (the result of `renderJobs`). Omitted in a dry run, where nothing is
   * written or removed and the result says what would be.
   */
  images?: ReadonlyMap<string, Uint8Array>
  /** `--force`. */
  force: boolean
  dryRun: boolean
}

export type WriteResult = Pick<ExportResult, 'written' | 'removed'>

/**
 * `.kit-shots.json` in a `StoreDestination.dir`: the files the last export wrote there. An owned
 * set is one `<locale>` dir (apple, per set id) or one `<locale>/images/phoneScreenshots` dir
 * (google). Export replaces the listed files; an image in an owned set that is not listed is in
 * the way (exit 4) unless `--force`. Nothing outside an owned set is ever touched.
 */
export interface ShotsManifest {
  version: 1
  /** Paths relative to the manifest's dir, `/`-separated, sorted. */
  files: string[]
}

export const MANIFEST_FILE = '.kit-shots.json'

// ---------------------------------------------------------------------------------------------
// Signatures: each module exports a function of exactly this type under the name in its comment.
// ---------------------------------------------------------------------------------------------

/**
 * `exportShots` in `command.ts`. Resolves stores, destinations and locales; plans; in a dry run
 * reports the plan without Chrome or writes; otherwise renders and writes. Emits the
 * `ExportResult` with `emitJson` under `--json`. Exit codes: see `kit shots export --help`.
 */
export type ExportShots = (ctx: KitContext, opts: ExportOptions) => Promise<void>

/**
 * `loadProject` in `project.ts`. `file` is absolute. A missing file or one that is not a version 1
 * or version 2 project is a KitError with exit 3.
 */
export type LoadProject = (file: string) => Promise<Project>

/**
 * `planExport` in `plan.ts`. Pure. Throws a KitError with exit 4 that lists every missing raw
 * shot, unless `allowMissing` (they go to `skipped`).
 */
export type PlanExport = (input: PlanInput) => ExportPlan

/** `pageBundle` in `page-bundle.ts`: the page JS, from `dist/shots-page.js` or built from source. */
export type PageBundle = () => Promise<string>

/**
 * `renderJobs` in `render.ts`. Serves the plan, runs Chrome, and resolves with one PNG per job,
 * keyed by `Job.id`. Every PNG is checked against the job's width and height (`imageInfo`) and
 * flattened onto white when it carries alpha (`flattenPng`), so the bytes are ready to write.
 * Chrome exiting early, the idle timeout, a page error (`PageDone.ok` false), a missing job or a
 * PNG of the wrong size is a KitError with exit 1; a Chrome binary that cannot be spawned is one
 * with exit 4. The server and the Chrome process tree are registered with `lib/cleanup`; a temp
 * dir that cannot be removed afterwards does not fail a finished render.
 */
export type RenderJobs = (plan: ExportPlan, opts: RenderOptions) => Promise<Map<string, Uint8Array>>

/**
 * `writeExport` in `write.ts`. Checks ownership of every set first (exit 4 on an unlisted image
 * without `force`); then, per store dir, writes the interim manifest and the PNGs, removes the
 * stale files of each owned set, and writes the final manifest. Nothing is written when any check
 * fails.
 */
export type WriteExport = (plan: ExportPlan, opts: WriteOptions) => Promise<WriteResult>
