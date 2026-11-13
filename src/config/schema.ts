import { z } from 'zod'
import { styleRules } from '../lib/storeshots/project'

export const verbs = ['lint', 'format', 'typecheck', 'test', 'build', 'dev', 'deploy'] as const
export type Verb = (typeof verbs)[number]

/** `kit release <name>` built-ins: a service cannot take one of these names. */
export const RESERVED_SERVICE_NAMES = [
  'ios',
  'android',
  'certs',
  'status',
  'promote',
  'rollout',
  'metadata',
  'rollback',
] as const

/** Suites that exist without config; `maestro.suites` entries of the same name start from them. */
export const DEFAULT_SUITES: Record<string, { tags: string[]; statusBar?: boolean }> = {
  qa: { tags: ['smoke'] },
  shots: { tags: ['screenshots'], statusBar: true },
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa`. */
const hexColor = z
  .string()
  .regex(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, 'Expected a hex colour like #1a2b3c')

export const kinds = ['gradle', 'kotlin', 'worker', 'vite', 'astro', 'docker', 'custom'] as const
export type Kind = (typeof kinds)[number]

export const tracks = ['internal', 'alpha', 'beta', 'prod'] as const
export type Track = (typeof tracks)[number]

/** A command string, or a list run in order. `false` turns a kind's default off. */
const command = z.union([z.string(), z.array(z.string()), z.literal(false)])
export type CommandValue = z.infer<typeof command>

const verbOverrides = Object.fromEntries(verbs.map((v) => [v, command.optional()])) as Record<
  Verb,
  z.ZodOptional<typeof command>
>

const deploy = z.union([
  command,
  z
    .object({
      /** Deploy command; defaults to the kind's. */
      run: command.optional(),
      /** kit commands run first, e.g. `env sync`. */
      before: z.array(z.string()).optional(),
    })
    .strict(),
])

const target = z
  .object({
    kind: z.enum(kinds),
    dir: z.string(),
    envs: z.array(z.string()).optional(),
    /** `--affected`: repo-relative dirs or globs outside `dir` whose changes also affect this target. */
    paths: z.array(z.string()).optional(),
    ...verbOverrides,
    deploy: deploy.optional(),
  })
  .strict()
export type TargetConfig = z.output<typeof target>

const workspace = z
  .object({
    ...verbOverrides,
    /** Commands run before lint, typecheck, test and build when the workspace runs (codegen). */
    prepare: command.optional(),
  })
  .strict()

export const configSchema = z
  .object({
    name: z.string().min(1),
    gradle: z
      .object({
        root: z.string(),
        /** Tasks `kit init` runs to fetch the wrapper and dependencies (`:shared:dependencies`). */
        init: z.union([z.string(), z.array(z.string())]).optional(),
      })
      .strict()
      .optional(),
    /** JetBrains Kotlin Toolchain (Amper): the dir holding the `kotlin` wrapper and project.yaml. */
    toolchain: z
      .object({
        root: z.string(),
        /** `./kotlin` argument strings `kit init` runs (`show dependencies -m shared`); default `--version`. */
        init: z.union([z.string(), z.array(z.string())]).optional(),
      })
      .strict()
      .optional(),
    versions: z
      .object({
        file: z.string(),
        keys: z.record(z.string(), z.string()),
      })
      .strict()
      .optional(),
    env: z
      .object({
        schema: z.string().optional(),
        outputs: z
          .record(
            z.string(),
            z
              .object({
                pick: z.array(z.string()).optional(),
                rename: z.record(z.string(), z.string()).optional(),
                /** Static local-only lines (`ENVIRONMENT: 'dev'`); never pushed. */
                vars: z.record(z.string(), z.string()).optional(),
              })
              .strict(),
          )
          .optional(),
        workerSecrets: z.record(z.string(), z.array(z.string())).optional(),
        githubSecrets: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    workspace: workspace.optional(),
    targets: z.record(z.string(), target).default({}),
    cloudflare: z
      .object({
        accountId: z.string().optional(),
        d1: z
          .record(
            z.string(),
            z
              .object({
                name: z.string(),
                target: z.string(),
                /** Used when `kit db` gets no --db and several are configured. */
                default: z.boolean().optional(),
                /** SQL file `kit db seed` runs, relative to the repo root. */
                seed: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * The app `kit app …` builds, installs and launches. Every field falls back to `release.*`
     * (bundleIds[0], project, scheme, packageName, module), so a repo with a release block needs none.
     */
    app: z
      .object({
        ios: z
          .object({
            bundleId: z.string().optional(),
            project: z.string().optional(),
            scheme: z.string().optional(),
            /** Kotlin toolchain only: the iOS app module; default the dir holding `project`. */
            module: z.string().optional(),
          })
          .strict()
          .optional(),
        android: z
          .object({
            packageName: z.string().optional(),
            /** Gradle project path (`:android`), or the toolchain module name (`androidApp`). */
            module: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** The devices kit boots: `kit device boot`, and every command that boots through it. */
    devices: z
      .object({
        android: z
          .object({
            /** Extra arguments for `emulator -avd <avd>` (`['-feature', '-HardwareDecoder']`); `KIT_EMULATOR_ARGS` adds this machine's. */
            emulatorArgs: z.array(z.string().min(1)).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** Maestro flows: `kit qa`, `kit shots`, `kit maestro`. */
    maestro: z
      .object({
        /** Dir holding `config.yaml` and the flows, relative to the repo root. */
        dir: z.string(),
        /** Maestro CLI version: `kit doctor` compares it, CI installs it. */
        version: z.string().optional(),
        /** Where Maestro writes its run dirs; default `<dir>/output`. */
        output: z.string().optional(),
        /** Device to boot when none is running: a simulator name or an AVD name. Default: newest, largest. */
        devices: z
          .object({ ios: z.string(), ipad: z.string(), android: z.string() })
          .partial()
          .strict()
          .optional(),
        /**
         * Named runs. `kit qa` runs `qa` (default: tags ['smoke']); `kit shots` runs `shots`
         * (default: tags ['screenshots'], statusBar, screenshots `<dir>/screenshots`) and with
         * `--full` `shots-full`.
         */
        suites: z
          .record(
            z.string(),
            z
              .object({
                /** Another suite whose fields this one starts from. */
                extends: z.string().optional(),
                /** Flow tags run in one Maestro invocation. */
                tags: z.array(z.string()).min(1).optional(),
                /** Tag sets run as separate invocations, in order; replaces `tags`. */
                stages: z.array(z.array(z.string()).min(1)).min(1).optional(),
                /** Fixture loaded before the flows; `false` loads none. */
                fixture: z.union([z.string(), z.literal(false)]).optional(),
                /** Pin the status bar to 9:41 first. */
                statusBar: z.boolean().optional(),
                /** Dir the `takeScreenshot` PNGs are copied to, under `<target>/`. */
                screenshots: z.string().optional(),
                /** Extra `-e KEY=VALUE` for the flows; PLATFORM is always set. */
                env: z.record(z.string(), z.string()).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    /** Store screenshots: `kit shots export` renders the raw shots into the store listing dirs. */
    shots: z
      .object({
        /** The saved project JSON (slides, text, frames), relative to the repo root. Optional with `pages`. */
        project: z.string().optional(),
        /** Dir holding the raw shots, `<raw>/<target>/…`; default the `shots` suite's screenshots dir. */
        raw: z.string().optional(),
        /** Font files the slides name, loaded before the first draw. */
        fonts: z
          .array(
            z
              .object({
                family: z.string(),
                /** woff2 or ttf, relative to the repo root. */
                file: z.string(),
                /** A CSS weight or range (`'400 800'`). */
                weight: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        /** The lockup drawn on a slide that has `showMascot`. */
        brand: z
          .object({
            /** svg or png, relative to the repo root. */
            mark: z.string(),
            /** The word drawn beside the mark. */
            wordmark: z.string().optional(),
            color: z.string().optional(),
            /** Font family of the wordmark. */
            font: z.string().optional(),
          })
          .strict()
          .optional(),
        /**
         * Style presets the editor offers beside its built-in ones: name, then the rules, the same
         * strict shape as the project's `style`. A preset named like a built-in one replaces it.
         */
        presets: z.record(z.string().min(1), styleRules).optional(),
        /** Colours the editor shows as swatches beside every colour control: hex colours, or name to colour. */
        palette: z.union([z.array(hexColor), z.record(z.string().min(1), hexColor)]).optional(),
        /**
         * HTML artwork pages (the App Store product page header, search results artwork): `kit shots
         * pages` renders each to a PNG with headless Chrome, flattened to no alpha.
         */
        pages: z
          .array(
            z
              .object({
                /** Names the page on the command line and in the default file name. */
                name: z
                  .string()
                  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, ".", "_" and "-"'),
                /** The HTML file, relative to the repo root. Its dir is served, so relative assets load. */
                file: z.string().min(1),
                /** The PNG's size in pixels; the page is laid out at width/scale by height/scale. */
                width: z.number().int().positive(),
                height: z.number().int().positive(),
                /** Device scale factor; default 2. Width and height must be multiples of it. */
                scale: z.number().int().min(1).max(4).optional(),
                /** Colour the PNG is flattened onto where the page is transparent; default `#ffffff`. */
                background: hexColor.optional(),
                /** The PNG, relative to the repo root; default `build/shots-pages/<name>-<w>x<h>.png`. */
                out: z.string().min(1).optional(),
              })
              .strict(),
          )
          .optional(),
        /** The size each target is exported at; default iphone-6.9, ipad-13, phone. */
        sets: z
          .object({
            ios: z.enum(['iphone-6.9', 'iphone-6.5', 'iphone-6.3']),
            ipad: z.enum(['ipad-13']),
            android: z.enum(['phone']),
          })
          .partial()
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** App state replayed onto a device (`kit fixture load`) or captured from it (`kit fixture dump`). */
    fixtures: z
      .object({
        /** Dir holding one sub-dir per fixture, relative to the repo root. */
        dir: z.string(),
        /** What travels. `from` is a file or a dir (trailing `/`) inside the fixture. */
        files: z
          .array(
            z
              .object({
                from: z.string(),
                /** Destination dir inside the simulator's data container (`Documents/databases/`). */
                ios: z.string().optional(),
                /** Destination dir inside the app's data dir (`databases/`). */
                android: z.string().optional(),
                /** A SQLite database: its WAL is checkpointed on dump. */
                sqlite: z.boolean().optional(),
              })
              .strict(),
          )
          .min(1),
        /** Dirs removed after a load, relative to the container / data dir (caches keyed on paths). */
        clear: z
          .object({ ios: z.array(z.string()), android: z.array(z.string()) })
          .partial()
          .strict()
          .optional(),
        /** Script run on the staged copy before it is pushed (date rebase); cwd is the staged fixture. */
        prepare: z.string().optional(),
      })
      .strict()
      .optional(),
    release: z
      .object({
        branches: z.array(z.string()).optional(),
        /** Dir holding the app's one-line `fastlane/Fastfile`; default gradle.root or toolchain.root, then the repo root. */
        fastlaneDir: z.string().optional(),
        notes: z.object({ maxLength: z.number().int().positive().optional() }).strict().optional(),
        preflight: z.array(z.string()).optional(),
        ios: z
          .object({
            bundleIds: z.array(z.string()).min(1),
            project: z.string(),
            scheme: z.string(),
            output: z.string(),
            teamId: z.string().optional(),
            /** xcconfig holding MARKETING_VERSION: `kit version bump` keeps it equal to the TOML. */
            xcconfig: z.string().optional(),
            testflightGroups: z.object({ alpha: z.string(), beta: z.string() }).partial().optional(),
            sentry: z.object({ org: z.string(), project: z.string() }).strict().optional(),
            /** Store listing dir (deliver layout), relative to the repo root; screenshots sit in `screenshots/` next to it. */
            metadata: z.string().optional(),
          })
          .strict()
          .optional(),
        android: z
          .object({
            packageName: z.string(),
            /** Gradle project path (`:android`), or the toolchain module name (`androidApp`). */
            module: z.string(),
            prodRollout: z.number().gt(0).lte(1).optional(),
            gates: z
              .array(
                z.object({
                  /** Gradle task, or `./kotlin` arguments with a toolchain (`test -m shared`). */
                  task: z.string(),
                  tracks: z.array(z.enum(tracks)),
                }),
              )
              .optional(),
            /** Store listing dir (supply layout: `<locale>/title.txt`, `<locale>/images/`), relative to the repo root. */
            metadata: z.string().optional(),
          })
          .strict()
          .optional(),
        services: z
          .record(
            z.string(),
            z.object({ versionKey: z.string(), build: z.string().optional(), deploy: z.string() }).strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.gradle && c.toolchain) {
      ctx.addIssue({
        code: 'custom',
        path: ['toolchain'],
        message: 'Set gradle or toolchain, not both: kit builds Android with one of them',
      })
    }
    for (const [name, d] of Object.entries(c.cloudflare?.d1 ?? {})) {
      if (!c.targets[d.target]) {
        ctx.addIssue({
          code: 'custom',
          path: ['cloudflare', 'd1', name, 'target'],
          message: `Unknown target "${d.target}"`,
        })
      }
    }
    const defaults = Object.entries(c.cloudflare?.d1 ?? {}).filter(([, d]) => d.default)
    if (defaults.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['cloudflare', 'd1'],
        message: `Only one database can be the default (${defaults.map(([k]) => k).join(', ')})`,
      })
    }
    for (const [name, suite] of Object.entries(c.maestro?.suites ?? {})) {
      if (
        suite.extends !== undefined &&
        !c.maestro?.suites?.[suite.extends] &&
        !(suite.extends in DEFAULT_SUITES)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['maestro', 'suites', name, 'extends'],
          message: `Unknown suite "${suite.extends}"`,
        })
      }
    }
    if (c.shots && c.shots.project === undefined && !c.shots.pages?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['shots'],
        message: 'Set shots.project (for export and studio) or shots.pages (for kit shots pages)',
      })
    }
    const seen = new Set<string>()
    for (const [i, page] of (c.shots?.pages ?? []).entries()) {
      if (seen.has(page.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['shots', 'pages', i, 'name'],
          message: `Duplicate page "${page.name}"`,
        })
      }
      seen.add(page.name)
      const scale = page.scale ?? 2
      for (const key of ['width', 'height'] as const) {
        if (page[key] % scale !== 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['shots', 'pages', i, key],
            message: `${key} ${page[key]} is not a multiple of the scale ${scale}`,
          })
        }
      }
    }
    if (c.shots?.project !== undefined && c.shots.raw === undefined && !c.maestro) {
      ctx.addIssue({
        code: 'custom',
        path: ['shots', 'raw'],
        message: 'Set shots.raw: without a maestro block there is no shots suite to take the raw dir from',
      })
    }
    if (c.targets.workspace) {
      ctx.addIssue({ code: 'custom', path: ['targets', 'workspace'], message: '"workspace" is reserved' })
    }
    for (const name of Object.keys(c.release?.services ?? {})) {
      if ((RESERVED_SERVICE_NAMES as readonly string[]).includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['release', 'services', name],
          message: `"${name}" is a kit release command; rename the service`,
        })
      }
    }
  })

export type KitConfigInput = z.input<typeof configSchema>
export type KitConfig = z.output<typeof configSchema>
