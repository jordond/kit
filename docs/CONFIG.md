# kit.config.ts reference

Every field of `kit.config.ts`, with defaults, validation rules and full examples. The schema is
`src/config/schema.ts`; the README covers the commands that read each block.

- [The file](#the-file)
- [Top-level fields](#top-level-fields)
- [`name`](#name)
- [`gradle` and `toolchain`](#gradle-and-toolchain)
- [`versions`](#versions)
- [`targets`](#targets)
- [`workspace`](#workspace)
- [`env`](#env)
- [`cloudflare`](#cloudflare)
- [`app`](#app)
- [`devices`](#devices)
- [`maestro`](#maestro)
- [`fixtures`](#fixtures)
- [`shots`](#shots)
- [`release`](#release)
- [Validation rules](#validation-rules)
- [Environment variables](#environment-variables)
- [Examples](#examples)

## The file

```ts
import { defineConfig } from '@jordond/kit'

export default defineConfig({
  name: 'my-app',
  targets: {
    api: { kind: 'worker', dir: 'apps/api' },
  },
})
```

- **Location.** `kit.config.ts` in the repo root, or `.kit/kit.config.ts` next to kit's `node_modules`
  (editors resolve the `@jordond/kit` import there). The root file wins when both exist.
- **Root.** kit walks up from the working directory to the nearest dir holding either file; that dir is
  the repo root. `KIT_ROOT` names it outright.
- **Paths.** Every path in the config is relative to the repo root, in both locations.
- **Values only.** The default export is a plain object: strings, numbers, booleans, lists. `defineConfig`
  only adds types. Logic goes in `.kit/commands/<verb>.ts` or a `release.preflight` module.
- **Strict.** Every object rejects unknown keys, so a typo is an error, not a silent no-op.
- **Errors.** An invalid file exits 3 and lists each problem by path:

  ```
  Invalid kit.config.ts:
    targets.api.kind: Invalid option: expected one of "gradle"|"kotlin"|…
    cloudflare.d1.main.target: Unknown target "apii"
  ```

- **Inspect.** `kit config` prints `{ root, config }` as JSON: the parsed file with defaults applied.
- **`.env`.** `<root>/.env` is loaded into the environment before commands run; values already set win.

## Top-level fields

| Field | Required | For |
| --- | --- | --- |
| [`name`](#name) | yes | Project name |
| [`gradle`](#gradle-and-toolchain) | no | Gradle build root. Exclusive with `toolchain` |
| [`toolchain`](#gradle-and-toolchain) | no | Kotlin toolchain (Amper) root. Exclusive with `gradle` |
| [`versions`](#versions) | no | Where version names live: `kit version`, `kit release` |
| [`targets`](#targets) | no (default `{}`) | What `kit lint`, `test`, `build`, `dev`, `deploy` run |
| [`workspace`](#workspace) | no | Repo-wide commands for the same verbs |
| [`env`](#env) | no | `.env` schema, rendered outputs, secret destinations: `kit env` |
| [`cloudflare`](#cloudflare) | no | Account id and D1 databases: `kit db`, worker commands |
| [`app`](#app) | no | The debug app `kit app`, `kit qa`, `kit shots` build and drive |
| [`devices`](#devices) | no | How kit boots devices |
| [`maestro`](#maestro) | no | Maestro flows and suites: `kit qa`, `kit shots`, `kit maestro` |
| [`fixtures`](#fixtures) | no | App state to load onto a device: `kit fixture` |
| [`shots`](#shots) | no | Store screenshot export: `kit shots export` |
| [`release`](#release) | no | Store releases, services, store listing: `kit release` |

## `name`

`string`, non-empty. The project name. Docker targets tag their image `<name>-<target>` (lower-cased,
other characters replaced with `-`).

## `gradle` and `toolchain`

Set one or neither, never both.

```ts
gradle: { root: 'apps/client', init: ':shared:dependencies' },
// or
toolchain: { root: '.', init: 'show dependencies -m shared' },
```

| Field | Type | Meaning |
| --- | --- | --- |
| `gradle.root` | `string` | Dir holding `gradlew`. Gradle tasks of every `gradle` target run here |
| `gradle.init` | `string \| string[]` | Tasks `kit init` runs to fetch the wrapper and dependencies. Default: none |
| `toolchain.root` | `string` | Dir holding the `kotlin` wrapper and `project.yaml`. `./kotlin` and `ktlint` run here |
| `toolchain.init` | `string \| string[]` | `./kotlin` argument strings `kit init` runs. Default `--version`, which downloads the toolchain |

Without the block, a `gradle` or `kotlin` target runs in its own `dir`. `release.fastlaneDir` defaults
to whichever root is set.

## `versions`

```ts
versions: {
  file: 'apps/client/gradle/libs.versions.toml',
  keys: { ios: 'app-ios-version', android: 'app-android-version', api: 'api-version' },
},
```

| Field | Type | Meaning |
| --- | --- | --- |
| `file` | `string` | A TOML file with a `[versions]` table |
| `keys` | `Record<string, string>` | kit's name for a version → the key in `[versions]` |

Values are `MAJOR.MINOR.PATCH`. `ios` and `android` are the names mobile releases read;
`kit version bump --platform <name>` takes any name in `keys`, and `release.services.<s>.versionKey`
refers to one. Build numbers are never stored: they come from the store.

## `targets`

A map of name → target. The name is what commands take: `kit test api`. `workspace` is reserved.

```ts
targets: {
  client: { kind: 'gradle', dir: 'apps/client' },
  api: {
    kind: 'worker',
    dir: 'apps/api',
    envs: ['staging', 'production'],
    paths: ['packages/shared', 'schema/**/*.sql', '!**/*.md'],
    typecheck: 'tsc --noEmit',
    deploy: { before: ['env sync'] },
  },
  site: { kind: 'astro', dir: 'apps/site', lint: false },
  tools: { kind: 'custom', dir: 'tools', test: ['bun test', 'bun run verify'] },
},
```

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `'gradle' \| 'kotlin' \| 'worker' \| 'vite' \| 'astro' \| 'docker' \| 'custom'` | Picks the default command for each verb |
| `dir` | `string` | The target's dir. Commands run here; changes under it select the target for `--staged` and `--affected` |
| `envs` | `string[]` | Values `--env` accepts for this target. `--env` on a target without `envs` is a usage error |
| `paths` | `string[]` | Dirs or globs outside `dir` whose changes also affect the target. A glob matching a dir claims everything under it; a `!` entry excludes, applied last and never to `dir` |
| `lint`, `format`, `typecheck`, `test`, `build`, `dev` | command | Overrides the kind's default for that verb |
| `deploy` | command, or `{ run?, before? }` | Overrides the deploy command; `before` lists kit commands run first |

**A command** is a string, a list of strings run in order, or `false`:

- A string runs through `sh -c` in the target's `dir`. Arguments after `--` on the command line are
  appended (`kit test api -- --watch`).
- On a `gradle` target, a Gradle task name (`spotlessCheck`, `:shared:test`) runs through `./gradlew` in
  `gradle.root` instead. A list of task names is one Gradle invocation.
- `false` turns the kind's default off: the target does not support that verb.
- A verb with no override and no kind default is skipped for that target.

**`deploy`** as an object: `run` is the deploy command (default: the kind's), and `before` is a list of
kit commands without the `kit` prefix (`'env sync'`), each run as a child kit process. A `before` step
several targets share runs once.

**`--env`.** With `envs` declared, `kit dev api --env staging` passes the env to the kind's default
command and sets `KIT_ENV` for every command of that target. An unknown env is a usage error.

### Kind defaults

| Kind | lint | format | test | build | dev | deploy |
| --- | --- | --- | --- | --- | --- | --- |
| `gradle` | `spotlessCheck` | `spotlessApply` | `test` | `build` | | |
| `kotlin` | `ktlint` | `ktlint -F` | `./kotlin test` | `./kotlin build` | | |
| `worker` | | | `test` script | `wrangler deploy --dry-run` | `wrangler dev` | `wrangler deploy` |
| `vite` | | | `test` script | `build` script | `dev` script | `deploy` script |
| `astro` | `astro check` | | | `build` script | `dev` script | `deploy` script |
| `docker` | | | | `docker build -t <name>-<target> .` | `docker run --rm -it <image>` | |
| `custom` | | | | | | |

- No kind has a `typecheck` default: set it on the target or in `workspace`.
- "script" is the `package.json` script of that name in the target's dir, run with the detected package
  manager; a missing script means the verb is skipped. `wrangler` and `astro` run through the package
  manager's exec.
- `worker` `dev` and `deploy` add `--env <env>`; `astro` deploy runs the `deploy:<env>` script.
- `kit build <target> --release` on `gradle` runs `<release.android.module>:bundleRelease`
  (`assembleRelease` for an APK); on `kotlin`, `./kotlin package -m <module>` (AAB only). Both need
  `release.android.module`.
- `kotlin` lint covers `**/*.kt` and `**/*.kts` outside `build/` and `node_modules/`; with `--staged`,
  only the staged Kotlin files.

## `workspace`

Repo-wide commands, run from the repo root. Use it for tools that cover the whole tree (Biome, `tsc -b`).

```ts
workspace: {
  prepare: 'bun run codegen',
  lint: 'biome check',
  format: 'biome check --write',
  typecheck: 'tsc -b',
},
```

| Field | Type | Meaning |
| --- | --- | --- |
| `lint`, `format`, `typecheck`, `test`, `build`, `dev`, `deploy` | command | Run for that verb, as a group named `workspace` |
| `prepare` | command | Run before `lint`, `typecheck`, `test` and `build` whenever the workspace runs (codegen) |

The workspace runs when no target is named, when `workspace` is named (`kit lint workspace`), or when a
named target is of kind `worker`, `vite`, `astro` or `custom`. With `--staged`, `lint` and `format` get
the staged files appended. With `--affected`, it runs whenever anything changed.

## `env`

One `.env` per repo; this block says what it holds and where each key goes.

```ts
env: {
  schema: '.kit/env.ts',
  outputs: {
    'apps/api/.dev.vars': { pick: ['API_SECRET', 'PUBLIC_URL'], vars: { ENVIRONMENT: 'dev' } },
    'apps/admin/.dev.vars': { rename: { X_INTERNAL_SECRET: 'API_SECRET' } },
  },
  workerSecrets: { api: ['API_SECRET'], admin: ['API_SECRET'] },
  githubSecrets: ['DEPLOY_TOKEN'],
},
```

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `string` | Module exporting a zod object (default export or `schema`) that declares each key |
| `outputs` | `Record<path, { pick?, rename?, vars? }>` | Files `kit env sync` renders from `.env`, in `.dev.vars` format, mode 0600 |
| `outputs.<path>.pick` | `string[]` | Keys written under their own name |
| `outputs.<path>.rename` | `Record<string, string>` | `{ OUTPUT_NAME: 'SOURCE_KEY' }` |
| `outputs.<path>.vars` | `Record<string, string>` | Static lines for local dev; never pushed anywhere |
| `workerSecrets` | `Record<target, string[]>` | Keys `kit env push` sends to that worker with `wrangler secret put` |
| `githubSecrets` | `string[]` | Keys `kit env push` sends with `gh secret set` |

- An output with neither `pick` nor `rename` gets every schema key. Lines are written in `vars`, `pick`,
  `rename` order. A blank value is written as a commented `# KEY=`.
- Without `schema`, the keys are those named in `outputs`, `workerSecrets` and `githubSecrets`: all
  optional, all secret, no validation.
- In the schema, a key is secret unless marked `.meta({ secret: false })`, and `kit env rotate` only
  takes keys with `.meta({ generate: 'hex' | 'base64url' | 'uuid' })`:

  ```ts
  // .kit/env.ts
  import { z } from 'zod'

  export default z.object({
    API_SECRET: z.string().min(32).meta({ generate: 'hex' }),
    SESSION_KEY: z.string().meta({ generate: 'base64url', length: 48 }),
    PUBLIC_URL: z.url().meta({ secret: false }),
    DEPLOY_TOKEN: z.string(),
  })
  ```

## `cloudflare`

```ts
cloudflare: {
  accountId: 'from-wrangler',
  d1: {
    main: { name: 'app-db', target: 'api', default: true, seed: 'apps/api/seed.sql' },
    analytics: { name: 'app-analytics', target: 'analytics' },
  },
},
```

| Field | Type | Meaning |
| --- | --- | --- |
| `accountId` | `string` | Pinned as `CLOUDFLARE_ACCOUNT_ID` for every wrangler command. A literal id, or `'from-wrangler'` to read `account_id` from a worker target's wrangler config |
| `d1.<key>.name` | `string` | The D1 database name |
| `d1.<key>.target` | `string` | The worker target that binds it; must be a key of `targets` |
| `d1.<key>.default` | `boolean` | Used when `kit db` gets no `--db` and several are configured. At most one |
| `d1.<key>.seed` | `string` | SQL file `kit db seed` runs |

`<key>` is what `--db` takes.

## `app`

The debug app that `kit app`, `kit qa` and `kit shots` build, install and launch. Every field falls back
to `release.*`, so a repo with a `release` block usually needs no `app` block.

```ts
app: {
  ios: { bundleId: 'app.example', project: 'ios/iosApp.xcodeproj', scheme: 'iosApp' },
  android: { packageName: 'app.example', module: ':android' },
},
```

| Field | Falls back to | Meaning |
| --- | --- | --- |
| `ios.bundleId` | `release.ios.bundleIds[0]` | Bundle id to install and launch |
| `ios.project` | `release.ios.project` | `.xcodeproj` or `.xcworkspace` |
| `ios.scheme` | `release.ios.scheme` | Xcode scheme |
| `ios.module` | the dir holding `project` | Kotlin toolchain only: the iOS app module |
| `android.packageName` | `release.android.packageName` | Application id |
| `android.module` | `release.android.module` | Gradle project path (`:android`) or toolchain module (`androidApp`) |

A field set in neither place is a config error (exit 3) when a command needs it.

## `devices`

```ts
devices: { android: { emulatorArgs: ['-feature', '-HardwareDecoder'] } },
```

| Field | Type | Meaning |
| --- | --- | --- |
| `android.emulatorArgs` | `string[]` (no empty strings) | Extra arguments after `emulator -avd <avd>`, for every command that boots the emulator |

Commit what every machine needs here; `KIT_EMULATOR_ARGS` adds this machine's, after these. kit picks
the AVD, so `-avd` and `@name` are refused.

## `maestro`

```ts
maestro: {
  dir: 'apps/client/maestro',
  version: '2.9.0',
  output: 'build/maestro',
  devices: { ios: 'iPhone 17 Pro Max', ipad: 'iPad Pro 13-inch (M4)', android: 'Pixel_9_Pro' },
  suites: {
    qa: { tags: ['smoke'], fixture: 'portland', env: { LOCALE: 'en' } },
    shots: { tags: ['appstore'], fixture: 'portland', screenshots: 'brand/screenshots' },
    'shots-full': { extends: 'shots', stages: [['appstore', 'appstore-full'], ['appstore-onboarding']] },
    nightly: { extends: 'qa', stages: [['smoke'], ['regression']], fixture: false },
  },
},
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | `string` | required | Dir holding `config.yaml` and the flows |
| `version` | `string` | | Maestro CLI version: `kit doctor` compares it, CI installs it |
| `output` | `string` | `<dir>/output` | Where Maestro writes its run dirs (`<output>/<target>-<suite>/`) |
| `devices.ios` / `ipad` / `android` | `string` | newest, largest | Simulator or AVD name to boot when nothing is running |
| `suites` | `Record<string, suite>` | `qa`, `shots` | Named runs |

A suite:

| Field | Type | Meaning |
| --- | --- | --- |
| `extends` | `string` | Another suite (configured or built-in) whose fields this one starts from |
| `tags` | `string[]`, at least one | Flow tags run in one Maestro invocation |
| `stages` | `string[][]`, at least one | Tag sets run as separate invocations, in order; replaces `tags` |
| `fixture` | `string \| false` | Fixture loaded before the flows; `false` loads none |
| `statusBar` | `boolean` | Pin the status bar to 9:41 first |
| `screenshots` | `string` | Dir the `takeScreenshot` PNGs are copied to, under `<target>/` |
| `env` | `Record<string, string>` | Extra `-e KEY=VALUE` for the flows; `PLATFORM` is always set |

Built-in suites exist without config, and a configured suite of the same name starts from them:

| Suite | Run by | Defaults |
| --- | --- | --- |
| `qa` | `kit qa` | `tags: ['smoke']` |
| `shots` | `kit shots` | `tags: ['screenshots']`, `statusBar: true`, screenshots in `<dir>/screenshots` |
| `shots-full` | `kit shots --full` | none: define it, usually with `extends: 'shots'` |

`--suite <name>` runs any other suite.

`kit add maestro` writes the starter flows directory at `maestro.dir` (or adds the block to this file when
it is missing), with a smoke flow tagged like the first stage of the `qa` suite. The reusable workflow
`.github/workflows/mobile-qa.yml` runs `kit qa` in CI: it installs Maestro at `maestro.version`, collects
`maestro.output` (default `<dir>/output`) as an artifact, and passes `devices.android.emulatorArgs` to the
emulator it boots (its `emulator-args` input adds `KIT_EMULATOR_ARGS`). See the README, "Maestro in CI".

## `fixtures`

App state replayed onto a device (`kit fixture load`) or captured from it (`kit fixture dump`).

```ts
fixtures: {
  dir: 'apps/client/fixtures',
  files: [
    { from: 'app_database.db', ios: 'Documents/databases/', android: 'databases/', sqlite: true },
    { from: 'settings.json', ios: 'Documents/', android: 'files/' },
    { from: 'entry_photos/', ios: 'Documents/entry_photos/', android: 'files/entry_photos/' },
  ],
  clear: { ios: ['Library/Caches'], android: ['cache', 'code_cache'] },
  prepare: 'apps/client/fixtures/rebase.sh',
},
```

| Field | Type | Meaning |
| --- | --- | --- |
| `dir` | `string` | Dir holding one sub-dir per fixture: `<dir>/<name>/` |
| `files` | array, at least one | What travels |
| `files[].from` | `string` | A file, or a dir (trailing `/`), inside the fixture |
| `files[].ios` | `string` | Destination dir inside the simulator's data container |
| `files[].android` | `string` | Destination dir inside the app's data dir |
| `files[].sqlite` | `boolean` | A SQLite database: its WAL is checkpointed on dump |
| `clear.ios` / `clear.android` | `string[]` | Dirs removed after a load, relative to the container / data dir |
| `prepare` | `string` | Script run on the staged copy before it is pushed; cwd is the staged fixture |

`prepare` gets `KIT_FIXTURE`, `KIT_FIXTURE_DIR`, `KIT_PLATFORM` and `KIT_ROOT`. A dump replaces the whole
fixture dir, so files not listed in `files` do not survive it.

## `shots`

Store screenshot export: `kit shots export` renders the raw shots into the store listing dirs.

```ts
shots: {
  project: 'brand/studio.json',
  raw: 'brand/screenshots',
  fonts: [{ family: 'Nunito', file: 'brand/fonts/nunito.woff2', weight: '400 800' }],
  brand: { mark: 'brand/logo.svg', wordmark: 'brewd', color: '#2c1e14', font: 'Nunito' },
  sets: { ios: 'iphone-6.9', ipad: 'ipad-13', android: 'phone' },
  presets: { sand: { background: { primaryColor: '#f4ecd8' }, headline: { color: '#2c1e14' } } },
  palette: { ink: '#2c1e14', sand: '#f4ecd8' },
},
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `project` | `string` | required | The saved project JSON (slides, text, frames) |
| `raw` | `string` | the `shots` suite's screenshots dir | Dir holding the raw shots, `<raw>/<target>/…`. Required when there is no `maestro` block |
| `fonts[].family` | `string` | | Family name the slides use |
| `fonts[].file` | `string` | | woff2 or ttf |
| `fonts[].weight` | `string` | | A CSS weight or range (`'400 800'`) |
| `brand.mark` | `string` | | svg or png drawn on slides that show the lockup |
| `brand.wordmark` | `string` | | The word drawn beside the mark |
| `brand.color` | `string` | | Lockup colour |
| `brand.font` | `string` | the slide's headline family | Font family of the wordmark and badges |
| `sets.ios` | `'iphone-6.9' \| 'iphone-6.5' \| 'iphone-6.3'` | `iphone-6.9` | Export size for iPhone |
| `sets.ipad` | `'ipad-13'` | `ipad-13` | Export size for iPad |
| `sets.android` | `'phone'` | `phone` | Export size for Android |
| `presets` | `Record<string, StyleRules>` | none | Style presets the editor offers after its own. The rules are checked with the same strict schema as the project's `style`, so a misspelt key is an error with its path |
| `palette` | `string[] \| Record<string, string>` | none | Hex colours (`#rgb`, `#rrggbb`, `#rrggbbaa`) shown as swatches beside every colour control in the editor; a map gives each swatch a name |

Every font family a slide names must be in `fonts` (CSS generics aside), or export stops with exit 3.
Output goes to `release.ios.metadata/../screenshots` and `release.android.metadata`.

### The project file

`shots.project` is a version 1 or a version 2 JSON file. Version 1 is the editor's file, one full slide
per screenshot, and keeps loading and exporting as before. Version 2 holds the rules once:

```jsonc
{
  "version": 2,
  "style": {
    "headline": { "fontFamily": "Baloo 2", "fontSize": 150, "color": "#2c1e14" },
    "device": { "position": "full-bleed", "scale": 0.85, "yOffset": 6 },
    "background": { "primaryColor": "#faf2e4", "secondaryColor": "#f1e1c7", "pattern": "warm-glow" },
    "brand": { "show": true, "position": "top-center" }
  },
  "targets": { "ipad": { "device": { "scale": 0.7 } } },
  "slides": [
    { "shot": "01-you.png", "headline": "Find your favorite cup of coffee" },
    { "shot": "02-map.png", "headline": "Every cafe you loved", "subheadline": "On one map",
      "style": { "device": { "yOffset": 2 } } }
  ],
  "locales": { "fr": { "you": { "headline": "Trouvez votre café préféré" } } }
}
```

| Key | Meaning |
| --- | --- |
| `style` | Rules for every slide. Sections `headline`, `subheadline`, `badge`, `device`, `background`, `brand`, all optional, per field |
| `targets.<ios\|ipad\|android>` | The same shape as `style`, for one target |
| `slides[].shot` | File name of the raw shot (`01-you.png`) |
| `slides[].headline`, `subheadline`, `badge` | The slide's text. `badge` is the badge text; `style.badge.enabled` shows it |
| `slides[].id`, `name` | Optional. See the derived fields |
| `slides[].style`, `slides[].targets` | Rules for this slide, and for this slide on one target |
| `locales` | Text per locale and slide id, as in version 1 |

Every object is strict in version 2: a key kit does not know fails with its path (exit 3).

**Merge order.** A field resolves through kit's built-in style, `style`, `targets[target]`, the slide's
`style`, the slide's `targets[target]`, then (text only) `locales`. Objects merge by field; nothing merges
as an array.

**Derived, never stored.**

| Value | Comes from |
| --- | --- |
| order | Array position |
| id | The shot name without its `NN-` prefix and extension (`01-you.png` is `you`), unless the slide sets `id`. Unique; the key into `locales` |
| name (the file's slug) | `name`, else the id |
| frame type and corner radius | The target (`iphone-pro` 56, `ipad-pro` 24, `android-pixel` 48), unless `device.frameType` is `clay-minimal`, `frameless` or `glass-card`. `device.cornerRadius` overrides the corner |
| panorama index and count | The slide's position and the number of slides |

**Removed from version 1:** `platform`, `dimensionId`, `imageSrc`, `order`, text `id`, `letterSpacing`,
text `yOffset`, `background.blur`, `customNotes`, `savedAt` and `position: 'angled-3d'` (it always drew as
`bottom-peek`). `brand.show` and `brand.position` replace `showMascot` and `mascotPosition`.

**`kit shots migrate`** prints the version 2 file for the version 1 project. The value most slides share
becomes `style`, a slide that differs keeps its own, and values equal to the built-in style are left out.
Before anything is written, kit proves that every target and locale draws the same slides as before; a
difference is named by slide and field (exit 4). `--write` replaces `shots.project`; with `--dry-run` it
only proves. `--json` prints `{ dryRun, file, written, project }`. Keys of a version 1 file that kit does
not know are dropped.

**`kit shots studio`** `[--port <n>] [--no-open]` serves the screenshot editor from the built
`dist/shots-editor/` (a source checkout without it says to run `bun run build`, or `bun run dev:studio`
to work on it). The server listens on `127.0.0.1` only, on a port the OS picks unless `--port` is set, and
every route sits under a random token in the URL it prints; stop it with Ctrl+C. It reads `shots.project`,
`shots.raw`, `shots.fonts` and `shots.brand` from the config and edits `shots.project` only when that is a
version 2 file: a version 1 file is shown read-only with `kit shots migrate --write` to run first.

An edit writes one field at one scope and no other: **All slides** (`style`), **This target**
(`targets.<target>`, the target in focus), **This slide** (the slide's `style`) or **This slide on this
target** (the slide's `targets.<target>`). Each style control shows the layer its value comes from and a
reset for the current scope; writing a value equal to what the layers below give removes the override and
empty objects are dropped, so the file stays minimal. Text, shot and name belong to the slide whatever the
scope, and the text of the locale picked in the header goes under `locales`.

Edits autosave a moment after the last change, and Cmd/Ctrl+S saves at once. Each save is checked against
the version 2 schema (a rejected save shows the bad fields and keeps your edits) and written atomically;
if the file changed on disk since it was loaded the editor offers Reload (drop your edits) or Overwrite.
The page warns before it is closed with unsaved changes. A new slide is picked from the raw shots
(never copied from another slide), and a PNG can be uploaded into the raw dir of the target in focus;
replacing an existing file asks first. With no project file the editor offers one slide per raw shot and
writes the file only when you confirm.

**Presets and palette.** The Presets group of the panel lists kit's three built-in presets (`light`,
`dark`, `bold-colour`) and then those of `shots.presets`; a preset named like a built-in one replaces it.
Applying one is a single undoable edit that **merges** into the project's `style` (the All slides layer):
the fields the preset names replace the same fields there and the rest stay, so a colour preset keeps your
fonts. It never touches `targets` or a slide's own overrides, which still win over it. A preset is a set of
style rules, the same shape as `style`:

```ts
presets: { sand: { background: { primaryColor: '#f4ecd8' }, headline: { color: '#2c1e14' } } },
palette: ['#2c1e14', '#f4ecd8', '#c97b31'],   // or { ink: '#2c1e14', sand: '#f4ecd8' } for named swatches
```

The palette is shown as swatches under every colour control; a click writes that colour at the current
scope.

**Export from the editor.** The Export button in the header picks the stores and a locale (or all of
them), saves any unsaved changes first, then runs the same code as `kit shots export` on the server. It
shows the progress, then how many files were written, removed or skipped, or the error `kit shots export`
would have printed. It does not pass `--allow-missing` or `--force`: a slide with no raw shot stops the
export, as on the command line.

**Overflow warnings.** After each edit the editor checks every slide for every locale and target, on a
small offscreen canvas while the browser is idle, and puts a warning on the filmstrip slide and on the
target column. Its tooltip names the locale, the target and the reason. Text overflows when the headline
wraps to more than 3 lines, when the text ends below the bottom of the canvas, or when the text pushes the
device down so that its top is past 55% of the canvas height (a device that sits low because of its
position or offsets is not flagged). The limits are in `editor/src/overflow.ts`.

**Actual size and drag to place.** The expand button on a target column draws that target at its export
resolution, one canvas pixel per screen pixel, in a scrollable view; the other columns keep fitting their
space. On a canvas, drag the device to set `device.xOffset` and `yOffset` (percent of the canvas, as in
the panel fields), scroll over it, or pinch, to set `device.scale`, and use the arrow keys on a focused
canvas to nudge by 0.5% (2% with Shift). The write goes to the current scope for the target you touched,
and a drag, or a burst of scrolling or key presses, is one undo step. The panel sliders follow along.

## `release`

```ts
release: {
  branches: ['main', 'release/*'],
  fastlaneDir: 'apps/client',
  notes: { maxLength: 500 },
  preflight: ['.kit/preflight/seed.ts'],
  ios: {
    bundleIds: ['app.example', 'app.example.widget'],
    project: 'apps/client/ios/iosApp.xcodeproj',
    scheme: 'iosApp',
    output: 'App.ipa',
    teamId: 'TEAM123456',
    xcconfig: 'apps/client/ios/Configuration/Config.xcconfig',
    testflightGroups: { alpha: 'Internal QA', beta: 'Beta Testers' },
    sentry: { org: 'my-org', project: 'ios' },
    metadata: 'apps/client/fastlane/metadata',
  },
  android: {
    packageName: 'app.example',
    module: ':android',
    prodRollout: 0.2,
    gates: [{ task: ':android:verifyBaselineProfile', tracks: ['beta', 'prod'] }],
    metadata: 'apps/client/fastlane/metadata/android',
  },
  services: {
    api: { versionKey: 'api', build: 'kit build api', deploy: 'kit deploy api' },
  },
},
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `branches` | `string[]` (globs) | `['main', 'release/*']` | Branches a release may run from |
| `fastlaneDir` | `string` | `gradle.root` or `toolchain.root`, then the repo root | Dir holding the app's one-line `fastlane/Fastfile` |
| `notes.maxLength` | positive integer | `500` | Length Play release notes are clamped to |
| `preflight` | `string[]` | | `definePreflight` modules run before every mobile release |

### `release.ios`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `bundleIds` | `string[]`, at least one | yes | The app first, then extensions (widgets). The first is the debug app's bundle id |
| `project` | `string` | yes | `.xcodeproj` or `.xcworkspace` |
| `scheme` | `string` | yes | Xcode scheme |
| `output` | `string` | yes | The `.ipa` kit writes, under `KIT_OUTPUT_DIR` or the repo root |
| `teamId` | `string` | | Apple developer team id |
| `xcconfig` | `string` | | xcconfig holding `MARKETING_VERSION`. `kit version bump` rewrites it; releases and `kit doctor` fail when it differs from the TOML. Needs `versions.keys.ios` |
| `testflightGroups.alpha` / `.beta` | `string` | | TestFlight group for that track. Default: the track name |
| `sentry` | `{ org, project }` | | Upload dSYMs to Sentry after a release; uses `SENTRY_AUTH_TOKEN` |
| `metadata` | `string` | | Store listing dir (deliver layout); screenshots sit in `screenshots/` next to it |

### `release.android`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `packageName` | `string` | yes | Application id |
| `module` | `string` | yes | Gradle project path (`:android`) or toolchain module (`androidApp`) |
| `prodRollout` | number, `0 < n <= 1` | | Staged rollout fraction for `prod`. Default `0.1` |
| `gates` | `{ task, tracks }[]` | | Tasks run before a release to the listed tracks. `task` is a Gradle task, or `./kotlin` arguments with a toolchain (`test -m shared`); `tracks` are `internal`, `alpha`, `beta`, `prod` |
| `metadata` | `string` | | Store listing dir (supply layout: `<locale>/title.txt`, `<locale>/images/`) |

### `release.services`

A map of name → service, released with `kit release <name>`: build, deploy, tag `<name>/v<version>`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `versionKey` | `string` | yes | A name in `versions.keys` |
| `build` | `string` | | Command run first |
| `deploy` | `string` | yes | Deploy command. `kit release rollback` needs it to be `kit deploy <worker target>` |

A service cannot be named `ios`, `android`, `certs`, `status`, `promote`, `rollout`, `metadata` or
`rollback`.

## Validation rules

Beyond types and unknown keys, loading fails (exit 3) when:

| Rule | Reported at |
| --- | --- |
| Both `gradle` and `toolchain` are set | `toolchain` |
| A D1 database names a target that does not exist | `cloudflare.d1.<key>.target` |
| More than one D1 database has `default: true` | `cloudflare.d1` |
| A suite extends a suite that is neither configured nor built-in | `maestro.suites.<name>.extends` |
| `shots` has no `raw` and there is no `maestro` block | `shots.raw` |
| A target is named `workspace` | `targets.workspace` |
| A service is named after a `kit release` command | `release.services.<name>` |

Other checks happen when a command needs the value: a missing `app` field with no `release` fallback,
`--release` builds without `release.android.module`, `release.ios.xcconfig` without `versions.keys.ios`.
`kit doctor` reports most of these ahead of time.

## Environment variables

Per-machine settings that sit beside the config. Set them in the shell or the repo's `.env`.

| Variable | Meaning |
| --- | --- |
| `KIT_ROOT` | The repo root, instead of walking up from the working directory |
| `KIT_EMULATOR_ARGS` | Extra emulator arguments for this machine, after `devices.android.emulatorArgs`. Split on whitespace; quotes keep an argument together |
| `KIT_DEVICE_TIMEOUT_MS` | How long an emulator boot may take. Default four minutes |
| `KIT_CHROME` | The Chrome binary `kit shots export` uses |
| `KIT_OUTPUT_DIR` | Where `kit release ios` writes `release.ios.output`. Default the repo root |

## Examples

### Minimal: one worker

```ts
import { defineConfig } from '@jordond/kit'

export default defineConfig({
  name: 'edge',
  targets: {
    api: { kind: 'worker', dir: '.' },
  },
})
```

### Gradle app with releases

```ts
import { defineConfig } from '@jordond/kit'

export default defineConfig({
  name: 'brewd',
  gradle: { root: 'apps/client', init: ':shared:dependencies' },
  versions: {
    file: 'apps/client/gradle/libs.versions.toml',
    keys: { ios: 'app-ios-version', android: 'app-android-version' },
  },
  targets: {
    client: { kind: 'gradle', dir: 'apps/client' },
  },
  release: {
    ios: {
      bundleIds: ['app.brewd'],
      project: 'apps/client/ios/iosApp.xcodeproj',
      scheme: 'iosApp',
      output: 'App.ipa',
      xcconfig: 'apps/client/ios/Configuration/Config.xcconfig',
    },
    android: {
      packageName: 'app.brewd',
      module: ':android',
      gates: [{ task: ':android:verifyBaselineProfile', tracks: ['beta', 'prod'] }],
    },
  },
})
```

`kit app`, `kit qa` and `kit shots` take the app from `release.*`; no `app` block is needed.

### Kotlin toolchain app

Lives in `.kit/kit.config.ts`; paths are still relative to the repo root.

```ts
import { defineConfig } from '@jordond/kit'

export default defineConfig({
  name: 'bekindrewind',
  toolchain: { root: '.' },
  versions: { file: 'libs.versions.toml', keys: { ios: 'app-ios-version', android: 'app-android-version' } },
  targets: {
    app: { kind: 'kotlin', dir: '.', dev: './kotlin run -m desktopApp' },
  },
  release: {
    android: { packageName: 'app.bekindrewind', module: 'androidApp' },
    ios: {
      bundleIds: ['app.bekindrewind'],
      project: 'iosApp/module.xcodeproj',
      scheme: 'app',
      output: 'App.ipa',
    },
  },
})
```

### Workers monorepo with env and D1

```ts
import { defineConfig } from '@jordond/kit'

export default defineConfig({
  name: 'infra',
  workspace: {
    lint: 'biome check',
    format: 'biome check --write',
    typecheck: 'tsc -b',
  },
  targets: {
    edge: {
      kind: 'worker',
      dir: 'apps/edge',
      envs: ['staging', 'production'],
      paths: ['packages/shared'],
      deploy: { before: ['env sync'] },
    },
    admin: { kind: 'vite', dir: 'apps/admin', paths: ['packages/shared'] },
    site: { kind: 'astro', dir: 'apps/site' },
  },
  env: {
    schema: '.kit/env.ts',
    outputs: {
      'apps/edge/.dev.vars': { pick: ['API_SECRET', 'PUBLIC_URL'], vars: { ENVIRONMENT: 'dev' } },
      'apps/admin/.dev.vars': { rename: { VITE_API_URL: 'PUBLIC_URL' } },
    },
    workerSecrets: { edge: ['API_SECRET'] },
    githubSecrets: ['CLOUDFLARE_API_TOKEN'],
  },
  cloudflare: {
    accountId: 'from-wrangler',
    d1: {
      main: { name: 'infra-db', target: 'edge', seed: 'apps/edge/seed.sql' },
    },
  },
  versions: { file: 'versions.toml', keys: { edge: 'edge-version' } },
  release: {
    services: {
      edge: { versionKey: 'edge', build: 'kit build edge', deploy: 'kit deploy edge' },
    },
  },
})
```

### Mobile app with QA, fixtures and store screenshots

```ts
import { defineConfig } from '@jordond/kit'

export default defineConfig({
  name: 'brewd',
  gradle: { root: 'apps/client' },
  versions: {
    file: 'apps/client/gradle/libs.versions.toml',
    keys: { ios: 'app-ios-version', android: 'app-android-version' },
  },
  targets: {
    client: { kind: 'gradle', dir: 'apps/client' },
  },
  devices: { android: { emulatorArgs: ['-feature', '-HardwareDecoder'] } },
  maestro: {
    dir: 'apps/client/maestro',
    version: '2.9.0',
    devices: { ios: 'iPhone 17 Pro Max' },
    suites: {
      qa: { fixture: 'portland' },
      shots: { tags: ['appstore'], fixture: 'portland', screenshots: 'brand/screenshots' },
      'shots-full': { extends: 'shots', stages: [['appstore', 'appstore-full'], ['appstore-onboarding']] },
    },
  },
  fixtures: {
    dir: 'apps/client/fixtures',
    files: [
      { from: 'app_database.db', ios: 'Documents/databases/', android: 'databases/', sqlite: true },
      { from: 'entry_photos/', ios: 'Documents/entry_photos/', android: 'files/entry_photos/' },
    ],
    clear: { ios: ['Library/Caches'], android: ['cache', 'code_cache'] },
    prepare: 'apps/client/fixtures/rebase.sh',
  },
  shots: {
    project: 'brand/studio.json',
    fonts: [{ family: 'Nunito', file: 'brand/fonts/nunito.woff2', weight: '400 800' }],
    brand: { mark: 'brand/logo.svg', wordmark: 'brewd', color: '#2c1e14', font: 'Nunito' },
  },
  release: {
    ios: {
      bundleIds: ['app.brewd'],
      project: 'apps/client/ios/iosApp.xcodeproj',
      scheme: 'iosApp',
      output: 'App.ipa',
      metadata: 'apps/client/fastlane/metadata',
    },
    android: {
      packageName: 'app.brewd',
      module: ':android',
      metadata: 'apps/client/fastlane/metadata/android',
    },
  },
})
```

### Debug app only, no releases

```ts
import { defineConfig } from '@jordond/kit'

export default defineConfig({
  name: 'prototype',
  gradle: { root: '.' },
  targets: {
    app: { kind: 'gradle', dir: '.' },
  },
  app: {
    ios: { bundleId: 'app.example', project: 'ios/iosApp.xcodeproj', scheme: 'iosApp' },
    android: { packageName: 'app.example', module: ':android' },
  },
})
```
