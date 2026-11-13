# kit

One dev toolkit for every app: the `kit` CLI, a shared fastlane setup, and Gradle conventions, shipped
together as `@jordond/kit`.

```sh
bun add -d @jordond/kit
kit --help
```

Install it globally too (`bun add -g @jordond/kit`) to get `kit` on your `PATH`: the global launcher finds
the nearest `kit.config.ts` and runs that repo's own pinned copy.

Every `kit.config.ts` field, with defaults and full examples: [docs/CONFIG.md](docs/CONFIG.md).

### Install dir: the root or `.kit/`

kit is a dev dependency in the root `package.json`, or in `.kit/package.json` for repos that must not have
a root `package.json`:

```sh
mkdir -p .kit && cd .kit && bun init -y && bun add -d @jordond/kit   # then: .kit/node_modules/.bin/kit
```

The config can sit next to it as `.kit/kit.config.ts`, where editors resolve the `@jordond/kit` import
through `.kit/node_modules`; a root `kit.config.ts` wins when both exist and still runs (kit resolves the
import to itself), but editors show it unresolved. Paths in the config are relative to the repo root in
both places. The launcher, `kit init`, `kit doctor`, `kit upgrade`, the setup action and
`mobile-distribute.yml` all look in both places. Kotlin toolchain repos need `.kit/`: the toolchain runs
`pnpm add` for its Kotlin/Wasm test browser in a build folder with no `package.json`, and pnpm installs
into the nearest one above it.

## New repos

`kit init` in a repo without a `kit.config.ts` can write the kit files first, then set the clone up as
usual (`.env`, install, toolchain download, fastlane bundle). Run it with a global kit or `bunx @jordond/kit init`.

```sh
kit init --template toolchain          # in a Kotlin toolchain project (a `kotlin` wrapper + project.yaml)
kit init --template gradle --name MyApp
kit init --template toolchain --dry-run
```

| Template | Writes |
| --- | --- |
| `toolchain` | `.kit/package.json`, `.kit/kit.config.ts`, `fastlane/Fastfile`, `.env.example`, `.editorconfig` (ktlint, 2-space), `mise.toml` (bun + ktlint, no java), `lefthook.yml`, `.github/workflows/{ci,distribute}.yml`, `renovate.json`; adds `node_modules/` and `.env` to `.gitignore` and `app-android-version` / `app-ios-version` to `libs.versions.toml` |
| `gradle` | root `package.json`, `kit.config.ts`, `apps/client/{settings.gradle.kts,gradle/libs.versions.toml,fastlane/Fastfile}`, `.env.example`, `mise.toml`, `lefthook.yml`, `.github/workflows/ci.yml`, `renovate.json`. Add the Gradle wrapper and the modules yourself |

- `toolchain` layers kit over an existing project and never writes a root `package.json`. Create the project
  first (`kotlin init`). A plain `kit init` there offers the template (`--yes` accepts it).
- It reads the project to fill the config: the `android/app` module and its `applicationId`, the `ios/app`
  module's Xcode project, scheme, bundle id, team and the xcconfig holding `MARKETING_VERSION`, and the
  `jvm/app` module for `kit dev`. An id it cannot find is `com.example.<name>`: replace it before a release.
  CI tests the non-Apple platforms the modules declare (`--platform jvm --platform android …`).
- Workflows pin kit by the commit of the running version's tag (`@<sha> # vX.Y.Z`).
- A file that already exists is kept; `.gitignore` and the catalog only gain lines. `renovate.json` is
  skipped when the repo has a Renovate config anywhere (`.github/renovate.json`, `.renovaterc`, …).

## Adding modules and targets

`kit add` scaffolds into a repo that already has kit. Both commands show the plan first, write nothing
with `--dry-run`, and print the plan or result as one document with `--json`.

```sh
kit add module core                              # KMP library: android, ios, jvm
kit add module feature:login --compose           # <gradle root>/feature/login, plus kit.compose
kit add module data --targets android,jvm --dir libs/data
kit add target api --kind worker --dir apps/api  # worker | vite | astro | docker | custom
```

| | Gradle (`gradle.root`) | Kotlin toolchain (`toolchain.root`) |
| --- | --- | --- |
| `kit add module <name>` writes | `build.gradle.kts` on kit's plugins only (`io.github.jordond.kit.kmp.library`, `…kit.compose` with `--compose`) with `kit { targets { … } }`, and `src/commonMain/kotlin/<package>/Placeholder.kt` | `module.yaml` (`kmp/lib`, the platforms of `--targets`; `--compose` enables Compose) and `src/Placeholder.kt` |
| and registers it in | `settings.gradle.kts`: one `include(":<name>")` after the last include (plus a `projectDir` line when `--dir` is not the path) | `project.yaml`: one entry in `modules:`, in the list's own style |
| Package | catalog `app-name` + the module path, the same rule the plugin uses for the Android namespace (`:feature:login` → `<app-name>.feature.login`) | the Android `applicationId` (or iOS bundle id) + the module name |

- Module names follow Gradle's project name rules (letters, digits, `-`, `_`, a letter first); `:` nests and
  maps to directories. The Kotlin toolchain names a module after its directory, so names do not nest there.
- A file that already exists is never overwritten: the command lists them and exits 2. `--force` overwrites.
  A module that is already included or listed is left as it is.
- Every edit keeps the file's line endings and is read back before it is written. A `settings.gradle` gets
  Groovy syntax (`include ':core'`). A settings file or `project.yaml` kit cannot edit safely is left
  untouched: the line to add goes to stdout and the exit code is 1.
- `kit add target` appends to `targets: { … }` in `kit.config.ts` (or `.kit/kit.config.ts`) with a text edit
  that keeps the file as written, then loads the config to prove it. A config it cannot edit safely
  (`targets` from a variable, a spread, a wrapper) is left untouched: the line to paste goes to stdout and
  the exit code is 1. The name cannot be an existing target, `workspace`, or a kit command.
- `--kind worker` with a `--dir` that does not exist yet also writes a minimal worker: `wrangler.jsonc`
  (placeholder name, no account id), `src/index.ts`, `package.json`, `tsconfig.json`. An existing directory
  is only registered; other kinds get an empty directory when it is missing.

## Keeping kit up to date

A repo pins kit twice: the `@jordond/kit` range in `package.json` (or `.kit/package.json`) and the
`jordond/kit/…@<sha> # vX.Y.Z` refs in `.github/workflows`. Both must name the same release;
`kit doctor --ci` fails when they differ.

By hand:

```sh
kit upgrade            # the latest release on npm
kit upgrade 0.6.0
```

Moves the range, runs the install, and rewrites every workflow ref to that release's tag commit.
Re-running it repairs workflow pins that lag the npm pin (`kit doctor --fix` does that part too).

With Renovate, extend kit's preset (the `kit init` templates write this `renovate.json`):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "github>jordond/kit//renovate/default"]
}
```

The preset puts the npm package and the workflow refs in one group, so a kit release arrives as one
PR; moves the `package.json` range itself (`^0.6.0` to `^0.6.1`), never only the lockfile; and keeps
the workflow refs pinned to a commit SHA with the `# vX.Y.Z` comment kit reads.

## Shell completion

```sh
source <(kit completion zsh)                                  # ~/.zshrc, after compinit
source <(kit completion bash)                                 # ~/.bashrc
kit completion fish > ~/.config/fish/completions/kit.fish
```

The script calls back into the `kit` on your `PATH`, so it follows each repo's pinned version and
works outside a repo too. `kit init` offers to install it for your `$SHELL` when `kit` is on `PATH`, and
never in CI: fish gets its completions file; zsh and bash get the script in `~/.config/kit/` and a line
in `~/.zshrc` (`~/.bash_profile` on macOS, else `~/.bashrc`) that sources it. Sourcing a file means no
kit process runs when a shell starts.

## Affected targets

```sh
kit check --affected                        # what this branch changed since origin/<default branch>
kit test --affected --base origin/develop
kit lint api web --affected                 # named targets ∩ affected ones
```

`lint`, `format`, `typecheck`, `check`, `test` and `build` take `--affected [--base <ref>]`: only the
targets changed since the merge base with `<ref>` run, counting commits on the branch plus staged,
unstaged and untracked files. The default base is `origin/<default branch>` (from `origin/HEAD`), then
`origin/main`, then `main`; a base that doesn't exist runs everything, with a warning.

A target is affected by a change under its `dir`, or under one of its `paths` (dirs or globs, for shared
code that lives elsewhere):

```ts
targets: {
  api: { kind: 'worker', dir: 'apps/api', paths: ['packages/shared', 'schema/**/*.sql'] },
}
```

A glob that matches a directory (`packages/*`) claims everything under it, and a `!` entry excludes:
`paths: ['packages/shared', '!**/*.md']`. Exclusions apply after the other entries and never to `dir`;
a file a target claims and then excludes is ignored (it does not count as unclaimed).

When HEAD is the default base itself with a clean tree (a push build of `main`), there is nothing to
compare: every target runs, with a warning, and `--json` adds `reason: "head-is-base"`. Pass
`--base HEAD~1` or the previous release tag there. With an explicit `--base`, no difference means
nothing runs. When `kit.config.ts` sits below the git root, a change outside it counts as unclaimed.

A changed file that no target claims (the root lockfile, `kit.config.ts`, CI workflows) affects every
target, and the workspace commands run whenever anything changed. Nothing changed exits 0. Unlike
`--staged`, tools get no file list: `--affected` only picks targets, and the two can't be combined.
`--staged` picks targets by the same `dir` and `paths` rule, but a staged file no target claims selects
none (the workspace commands still get it), so pre-commit hooks stay fast.
`--json` adds `affected` (the target names) and `base`.

## Step timings

After a verb runs more than one step, the summary lists the five slowest (`--verbose`: all of them).
With `--json`, every step has `ms` and the document a total `ms`; `deploy`, `release` and `init` report
the same fields.

## Clean

```sh
kit clean --dry-run       # list what would go, with sizes
kit clean client          # one target
kit clean --deep --yes
```

`kit clean [targets...]` deletes build output: `.gradle/`, `.kotlin/` and each Gradle project's `build/`
under the Gradle root (never `~/.gradle`), the Kotlin toolchain's `build/`, `dist/`, `.wrangler/tmp`,
`.astro` and the bundler caches in `node_modules` for worker, vite and astro targets, and the
`release.ios.output` .ipa with its dSYM zip (their dir too, only when it holds nothing else and git
tracks nothing in it). `--deep` adds `node_modules` (root and `.kit/`), `.wrangler/state` (your local
D1/KV data) and the configured iOS project's Xcode DerivedData. It lists every path with its size and asks
first (`--yes` skips the question); `--json` reports `{ removed: [{ path, bytes }], bytes }`. Symlinks
and anything that resolves outside the repo root are refused.

## Devices and the debug app

```sh
kit device list                 # simulators, emulators and phones; booted first
kit device boot ios             # newest, largest iPhone; created when it does not exist
kit device boot ipad
kit device boot android         # newest, largest Pixel AVD; created on a Play image
kit device statusbar ios        # 9:41, full battery and signal; --clear restores it

kit app build android           # debug build; prints the .apk path
kit app install ios             # build, then install on the simulator
kit app run android --device emulator-5554
kit app install android --file app.aab
kit app uninstall ios
kit app clear android           # wipe the app's data, keep it installed
```

`kit app` and `kit device` take a platform: `ios`, `android`, and for devices `ipad` (the iOS app on an
iPad simulator). kit owns the device lifecycle with `simctl`, `adb`, `emulator` and `avdmanager`.

**Which device.** `--device <id>` is used as given (a simulator UDID or an adb serial). Without it: the
one running device; with several up, a picker (`--yes` takes the newest, largest iPhone or iPad, and an
emulator over a cabled phone); with none, kit offers to boot one, creating it first when needed. Without
a terminal that question needs `--yes`. `uninstall`, `clear` and `statusbar` never boot a device.

**Which emulator image.** A new AVD gets a Play system image when one is installed, newest API first
(otherwise `google_apis`, then AOSP). In CI the emulator starts headless.
`KIT_DEVICE_TIMEOUT_MS` changes the four minutes an emulator boot may take.

**Emulator arguments.** kit starts the emulator as `emulator -avd <avd>`, the headless flags in CI, then
any extra arguments from two places, in this order:

```ts
// kit.config.ts: an API 37 Play image plays no video without this
devices: { android: { emulatorArgs: ['-feature', '-HardwareDecoder'] } },
```

```sh
# this machine only: the shell, or the repo's .env (Bun loads it before kit starts)
KIT_EMULATOR_ARGS='-packet-streamer-endpoint default'
```

The config holds what the project needs on every machine, so it is committed; `KIT_EMULATOR_ARGS` holds
what this machine needs (a stale `netsimd` from another session) and stays out of the repo. It is split
on whitespace, with `'…'` and `"…"` keeping an argument that has spaces together. kit picks the AVD, so
`-avd` and `@name` are refused. The arguments apply to every command that boots the emulator
(`kit device boot android`, `kit qa android`, `kit shots android`, `kit fixture load android`); an
emulator that is already running keeps the ones it was started with, and kit says so. A boot that times
out shows the last lines of the emulator's log and where the log is.

**What gets built.** `kit app build <ios|android>` builds the debug variant (`--release` for release)
and prints the artifact path on stdout:

| | Android | iOS simulator |
| --- | --- | --- |
| Gradle | `<module>:assembleDebug` | `xcodebuild -scheme <scheme> -configuration Debug` for the simulator |
| Kotlin toolchain | `./kotlin build -m <module> -p android -v debug` | `./kotlin build -m <module> -p iosSimulatorArm64 -v debug` |

`kit build <target> --release` is still the signed store build; `kit app build` is for a device.

**Installing.** `kit app install` builds first; `--no-build` installs the newest artifact already there,
and `--file` installs a given `.apk`, `.app` or `.aab` (an AAB goes through `bundletool`). A physical
iPhone takes `--device <id> --file <path>` and installs with `devicectl`.

The app comes from `release.*` in kit.config.ts. Set `app` only when it differs, or when the repo has no
release block:

```ts
app: {
  ios: { bundleId: 'app.example', project: 'ios/iosApp.xcodeproj', scheme: 'iosApp' },
  android: { packageName: 'app.example', module: ':android' },
},
```

`kit doctor` adds three checks for a repo with a mobile app, all warnings: `adb`, the Android emulator
(emulator, `avdmanager`, a system image for this machine) and an installed iOS simulator runtime.

## Maestro: QA and screenshots

The repo writes [Maestro](https://maestro.dev) flows; kit does the rest: device, build, install,
status bar, fixture, the runs, and collecting the screenshots.

```sh
kit qa ios                      # build, install, load the fixture, run the smoke flows
kit qa android --device emulator-5554 --junit report.xml
kit qa ios --no-build --tags smoke,settings
kit shots ios                   # 9:41 status bar, fixture, flows, PNGs copied out
kit shots ipad --full           # the shots-full suite
kit fixture load ios portland   # replay app state onto the device
kit fixture dump android portland
kit maestro studio              # the Maestro CLI itself
```

```ts
maestro: {
  dir: 'apps/client/maestro',            // config.yaml and the flows
  version: '2.9.0',                      // kit doctor compares it; CI installs it
  devices: { ios: 'iPhone 17 Pro Max' }, // optional: what to boot when nothing is running
  suites: {
    qa: { tags: ['smoke'], fixture: 'portland' },
    shots: { tags: ['appstore'], fixture: 'portland', screenshots: 'brand/screenshots' },
    'shots-full': { extends: 'shots', stages: [['appstore', 'appstore-full'], ['appstore-onboarding']] },
  },
},
fixtures: {
  dir: 'apps/client/fixtures',           // one dir per fixture
  files: [
    { from: 'app_database.db', ios: 'Documents/databases/', android: 'databases/', sqlite: true },
    { from: 'entry_photos/', ios: 'Documents/entry_photos/', android: 'files/entry_photos/' },
  ],
  clear: { ios: ['Library/Caches'], android: ['cache', 'code_cache'] },
  prepare: 'apps/client/fixtures/rebase.sh',
},
```

**Suites.** `kit qa` runs the `qa` suite (default: tags `smoke`), `kit shots` the `shots` suite (default:
tags `screenshots`, status bar pinned, PNGs to `<maestro.dir>/screenshots/<target>/`), `kit shots --full`
the `shots-full` suite, and `--suite <name>` any other. A suite has `tags` (one Maestro run) or `stages`
(one run per tag set, in order). Stages exist because Maestro's own `executionOrder` breaks under tag
filters: a flow that wipes app state belongs in a last stage of its own. Flows get `PLATFORM=ios|android`
plus the suite's `env`.

**The run.** One device is resolved first (see Devices above), then everything lands on it: the debug
build and install (`--no-build` drives what is installed), the 9:41 status bar when the suite asks, the
fixture (`--fixture <name>`, `--no-fixture`), then each stage. A failing stage stops the run and exits 1. The status bar stays pinned afterwards
(`kit device statusbar <target> --clear`).
Screenshots are the flows' `takeScreenshot` PNGs: a shot replaces the file of the same name and leaves the
rest. Maestro's logs stay under `<maestro.dir>/output/<target>-<suite>/`. Maestro drives simulators and
Android devices, not physical iPhones.

**Fixtures.** `<fixtures.dir>/<name>/` holds the files listed in `fixtures.files`; `ios` and `android`
are destination dirs inside the simulator's data container and the app's data dir. Loading stops the
app, replaces each destination (a stale file is never left over), and removes the `clear` dirs. `prepare`
runs on a staged copy first, with `KIT_FIXTURE`, `KIT_FIXTURE_DIR`, `KIT_PLATFORM` and `KIT_ROOT` set: the
place to rebase dates so an old capture reads as current. Android goes through `run-as`, so the installed
build must be debuggable (`kit app install android` installs one); a rooted adb is the fallback for load. `kit fixture dump` captures the same
files back, checkpoints SQLite WALs, and replaces the whole fixture dir only when the capture succeeded: files not listed in `fixtures.files`
do not survive a dump.

`kit lint` also runs `maestro check-syntax` over the flows, and `kit doctor` checks the Maestro version
against `maestro.version` and that Java 17+ is there.

### Store screenshots

`kit shots export` turns the raw shots into the images the stores take: each slide of a saved project
(background, headline, device frame around the raw shot) is drawn by headless Chrome at the store's
exact size and written into the store listing dirs, ready for `kit release metadata push --screenshots`.

```sh
kit shots ios && kit shots ipad && kit shots android   # capture the raw shots
kit shots export                                       # compose them, for both stores and every locale
kit shots export --store apple --locale en-US
kit shots export --out build/store-shots --dry-run --json
kit release metadata push ios --only-screenshots       # upload the images, leave the text (see Store listing)
```

```ts
shots: {
  project: 'brand/studio.json',          // the saved project: slides, text, frames
  raw: 'brand/screenshots',              // optional: default the shots suite's screenshots dir
  fonts: [{ family: 'Nunito', file: 'brand/fonts/nunito.woff2', weight: '400 800' }],
  brand: { mark: 'brand/logo.svg', wordmark: 'brewd', color: '#2c1e14', font: 'Nunito' },
  sets: { ios: 'iphone-6.9' },           // optional: iphone-6.9 | iphone-6.5 | iphone-6.3
},
```

**The project file.** A version 1 project as the screenshot editor saves it: `slides[]`, each with a
`name`, an `order`, the `sourceFile` of its raw shot (`home.png`), its text, device and background. kit
ignores the editor's `imageSrc` and `dimensionId`. Every slide is exported for every target: the raw shot
is `<raw>/<target>/<locale>/<sourceFile>` when that exists, else `<raw>/<target>/<sourceFile>`, and a
slide framed in an iPhone gets the iPad or Pixel frame on the other targets. An optional `locales` block
replaces the text per locale and slide id; a field left out keeps the slide's own text, and `fr-CA`
falls back to another `fr` entry before that:

```json
"locales": { "fr-FR": { "slide-1": { "headline": "…", "subheadline": "…", "badge": "…" } } }
```

**Version 2 and `kit shots migrate`.** A version 2 project (`"version": 2`) holds the rules once: a
`style`, per-target `targets`, and slides of just `shot`, `headline` and what differs. Slide ids come from
the shot name (`01-you.png` is `you`), and `locales` is keyed by them. Version 1 files keep working.
`kit shots migrate` prints the version 2 file; `kit shots migrate --write` replaces `shots.project` once it
has proved that every target and locale draws the same slides (`--dry-run` only proves). The merge order,
derived fields and the file's shape are in [docs/CONFIG.md](docs/CONFIG.md#the-project-file).

**Fonts and brand.** Every font family a slide names has to be in `shots.fonts` (the CSS generics
`sans-serif`, `serif`, `monospace` and `system-ui` aside): Chrome would draw an unknown family in a
fallback font without complaint, so export stops first (exit 3). `brand` is the lockup drawn on slides
that show it: the mark, and the wordmark beside it. The wordmark and a slide's badge are drawn in
`brand.font`, or in the slide's headline family when there is none, so that family has to be declared
even on a slide whose headline is empty.

**Output.** Locales are, per store, the locale dirs already in that store's metadata dir (`en-US` when
there are none yet); `--locale` narrows them. In the iOS metadata dir, the dirs deliver does not read
as a locale are left out (`default`, `review_information`, `trade_representative_contact_information`,
`app_clip_review_information`, `android`, `fonts`, `appleTV`, `iMessage`), and in either store so is a
dir whose name cannot be a locale (`Old Backup`).

| Store | Target | Size | Written to |
| --- | --- | --- | --- |
| apple | ios | 1320x2868 (`iphone-6.9`) | `<release.ios.metadata>/../screenshots/<locale>/NN_iphone-6.9_<slug>.png` |
| apple | ipad | 2064x2752 (`ipad-13`) | same dir, `NN_ipad-13_<slug>.png` |
| google | android | 1440x2560 (`phone`) | `<release.android.metadata>/<locale>/images/phoneScreenshots/NN_<slug>.png` |

`NN` is the slide's position and `<slug>` its name. Each dir gets a `.kit-shots.json` listing what
export wrote. The next export replaces those files and removes the ones it no longer writes; an image
in the same set that it did not write is in the way (exit 4) until it is moved or `--force` replaces it.
So is a directory or a dangling link with an image name there: the uploader would take it and fail.
Play's icon, feature graphic and other screenshot types are never touched. The PNGs have no alpha
channel, which App Store Connect requires.

| Flag | Meaning |
| --- | --- |
| `--store apple\|google\|both` | Default `both`. A store with no `release.<platform>.metadata` is a usage error unless `--out` is given |
| `--locale <a,b>` | Only these locales |
| `--out <dir>` | Write `<dir>/apple/<locale>/…` and `<dir>/google/<locale>/images/phoneScreenshots/…` instead of the store dirs |
| `--allow-missing` | Skip a slide whose raw shot is absent, instead of stopping (exit 4) |
| `--force` | Replace images in an exported set that kit did not write |
| `--dry-run` | Print what would be written and removed; Chrome is not started and nothing changes |
| `--json` | `{ dryRun, stores, written: [{ store, target, set, locale, slide, file, width, height }], removed, skipped }` |

`--store`, `--locale` and `--out` given an empty or whitespace-only value (`--out "$OUT"` with `OUT`
unset) are a usage error (exit 2), not the default.

Nothing is written unless every image came back at its exact size: a Chrome that exits, a page error or
five minutes without a new image is exit 1 with the store dirs as they were. Every rendered PNG is held
in memory until all of them are back, so memory grows with slides x locales (a few MB each); `--store`
and `--locale` split a large export into smaller runs. Before Chrome starts, export checks
that the raw shots, font and brand files are there, that Chrome is, and that no set has more slides
than its store keeps (10 on the App Store, 8 on Play); each of those is exit 4. Chrome is the installed
Google Chrome or Chromium (112 or newer), or the binary `KIT_CHROME` names.

## Repo commands

`.kit/commands/<path>.ts` adds `kit <path>`; the file path is the command path. Keep heavy imports
inside `run` so help stays fast.

### Wrapping a built-in

Set `override: true` to replace a built-in with the same path. The override can still run the
built-in through `ctx.builtin(path, options)`, so it only adds what the repo needs.

`ctx.builtin` options (each defaults to the caller's own):

| Option        | Effect                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `mute`        | Regex; matching child-output lines never reach the tree, failure output or `--json` |
| `args`        | Flag values the built-in sees                                           |
| `positionals` | Targets the built-in sees (`kit test api` → `['api']`)                  |
| `rest`        | Arguments after `--`                                                    |

Example: brewd's iOS test link pulls in RevenueCat's prebuilt static libraries (`purchases-kmp`), which
were built with `-gmodules` on RevenueCat's CI. ld warns about each one's missing module cache, about
74 times per run, and has no switch to silence just those. Muting them on RevenueCat's build path
keeps every other linker warning:

```ts
// .kit/commands/test.ts
import { defineCommand } from '@jordond/kit'

/** ld: "… /Users/distiller/project/kn-core/… was built with -gmodules …" from purchases-kmp's static libs. */
const REVENUECAT_MODULE_CACHE_NOISE = /\/Users\/distiller\/project\/kn-(core|ui)\/|built with -gmodules/

export default defineCommand({
  description: 'Run the test suites',
  override: true,
  async run(ctx) {
    await ctx.builtin('test', { mute: REVENUECAT_MODULE_CACHE_NOISE })
  },
})
```

`kit test`, `kit test client` and `kit test --json` all keep working; only the noise is gone.

## Doctor

`kit doctor` checks the tools the config needs. Two checks only warn, because they are per-machine setup:
a repo with `mise.toml` warns when mise isn't installed or a pinned version differs, and a repo with
`lefthook.yml` warns when lefthook isn't installed or `lefthook install` hasn't been run in the clone.

When the config has a `shots` block, `kit doctor` also checks for Chrome, which `kit shots export` uses to render store screenshots. It warns if Chrome or Chromium is missing or older than 112; install Google Chrome or set `KIT_CHROME` to a Chrome or Chromium binary.

```sh
kit doctor --fix             # list the fixes, confirm once, apply, check again
kit doctor --fix --yes       # no question (needed without a terminal)
kit doctor --fix --dry-run   # list them only
```

`--fix` repairs what is safe and local, runs the touched checks again, then reports (and exits on)
the state after the fixes. A fix is "fixed" only when its check passes afterwards: a command that ran
and left the check failing (tools `mise install` put somewhere this shell does not look yet) is
reported as applied, with the next step.

| Check | Fix |
| --- | --- |
| lefthook hook not installed | `lefthook install` |
| mise tool missing or drifted | `mise install` |
| wrangler not installed | the worker's install: the package manager of the nearest lockfile above the worker dir, run where that lockfile is |
| iOS / Android version drift | writes the TOML version to the xcconfig's `MARKETING_VERSION` / the module.yaml's `versionName` |
| Kotlin toolchain wrapper not executable | `chmod +x` |
| workflow pins behind the npm pin | moves them to that release's tag commit, as `kit upgrade` does; skipped with a note when the tag cannot be resolved (offline) |

Xcode, the JDK, the Android SDK, logins, `.env` values and secrets are never fixed: those checks keep
their hint. Plain `kit doctor` ends with `N fixable with kit doctor --fix` when there is something to
apply, and `--json` adds `fixes: [{ id, description, applied, ok, error?, hint? }]`, where `ok` is whether
the check passes after the fix.

## Changelog

```sh
kit changelog                              # Markdown since the last release tag
kit changelog --platform ios               # since the last ios/v* tag
kit changelog --from v0.5.0 --to v0.6.0 --json
kit changelog --platform android --write   # add a section to CHANGELOG.md
kit changelog --write docs/CHANGES.md
```

Groups the Conventional Commits in the range into Breaking (`!` or a `BREAKING CHANGE:` footer),
Features, Fixes, Performance and Other. `chore(release)` and merge commits are always left out;
`chore`, `test`, `ci` and `style` too unless `--all` is given. The range starts at the newest release
tag reachable from `--to` (`<platform>/v*` with `--platform`, any `…v<version>` tag without); with no
tag it is the whole history. `--to <tag>` lists that release: the range starts at the tag before it.

`--write` puts a `## <version> (<date>)` section above the newest one in `CHANGELOG.md` (or the file
named after it), creating the file when needed. The version is the `--to` tag's, else the platform's
version in the catalog TOML, else the root `package.json` version, else `Unreleased`; with `--platform`
the heading is `## ios 1.4.0 (…)`. A version that already has a section is not added again; the
`Unreleased` section is rewritten in place on each run, so new commits keep landing in it.

In a shallow clone with no release tag in it (CI's default checkout) the range would be whatever was
fetched: `kit changelog` warns, and `--write` refuses (exit 4) until the history is there
(`git fetch --unshallow --tags`, or `fetch-depth: 0`). Any other git failure (a ref that does not
exist, not a repository) is an error, never an empty changelog.
`--json` prints `{ from, to, sections: [{ title, commits }] }`.

## Kotlin toolchain

Apps built with the [JetBrains Kotlin Toolchain](https://kotlin-toolchain.org/latest/) (formerly Amper)
have a `kotlin` wrapper, `project.yaml` and one `module.yaml` per module instead of Gradle.
[`kit init --template toolchain`](#new-repos) sets all of this up. By hand: install kit in
[`.kit/`](#install-dir-the-root-or-kit), set `toolchain.root` in place of `gradle` (they are exclusive)
and use the `kotlin` target kind:

```ts
export default defineConfig({
  name: 'bekindrewind',
  toolchain: { root: '.' },
  versions: { file: 'libs.versions.toml', keys: { ios: 'app-ios-version', android: 'app-android-version' } },
  targets: {
    app: { kind: 'kotlin', dir: '.', lint: 'ktlint', format: 'ktlint -F', dev: './kotlin run -m desktopApp' },
  },
  release: {
    android: { packageName: 'app.bekindrewind', module: 'androidApp' },
    ios: { bundleIds: ['app.bekindrewind'], project: 'iosApp/module.xcodeproj', scheme: 'app', output: 'App.ipa' },
  },
})
```

| | Gradle | Kotlin toolchain |
| --- | --- | --- |
| `kit test` / `kit build` | `./gradlew test` / `build` | `./kotlin test` / `build` |
| `kit lint` / `kit format` | `spotlessCheck` / `spotlessApply` | `ktlint` / `ktlint -F` over `**/*.kt` and `**/*.kts`, skipping `build/` |
| `kit build <t> --release` | `<module>:bundleRelease` | `./kotlin package -m <module>` (AAB only) |
| passthrough | `kit gradle …` | `kit kotlin …` |
| `kit init` | `gradle.init` tasks | `toolchain.init` (default `./kotlin --version`, which downloads the toolchain) |
| `kit doctor` | java, Android SDK, catalog keys | the wrapper and its pinned `kotlin_cli_version`, and ktlint; no java or SDK needed |

The toolchain has no linter, so `kotlin` targets use the standalone `ktlint` binary: pin it in `mise.toml`
(`ktlint = "1.8.0"`) and style it with `.editorconfig`. `kit lint --staged --fix` passes only the staged
Kotlin files. Override with `lint:` / `format:` on the target, or `false` to turn one off.

`kit release android` runs `./kotlin package -m <release.android.module>`. The toolchain takes no build
properties, so kit writes `versionName`, `versionCode` and `signing` (a `keystore.properties` in kit's
0600 temp dir, built from the `ANDROID_KEYSTORE_*` secrets) into the module's `module.yaml` for the build and
restores the file afterwards, also on failure or Ctrl-C. `release.android.gates` tasks are `./kotlin`
arguments (`test -m shared`). `kit version bump` also rewrites `settings.android.versionName` in the app's
`module.yaml`, and releases and `kit doctor` fail if it differs from the TOML. There is no `BuildConstants.IS_INTERNAL`:
it comes from kit's Gradle plugin.

`kit release ios` is the same as for Gradle apps: the Xcode project's "Build Kotlin" phase runs the toolchain.
Give the Release configuration manual signing with the match profiles, a `DEVELOPMENT_TEAM`, and
`MARKETING_VERSION` in `release.ios.xcconfig`.

## Env

One `.env` per repo; `env.schema` (a zod object, usually `.kit/env.ts`) declares each key, and
`env.workerSecrets` / `env.githubSecrets` say which remotes hold it. Keys are secret unless marked
`.meta({ secret: false })`. Values never reach output: only names and statuses are printed.

| Command | Does |
| --- | --- |
| `kit env push` | Every worker in `env.workerSecrets` (`wrangler secret put`) and `env.githubSecrets` (`gh secret set`); lists names, confirms (`--yes` skips), `--dry-run` only lists |
| `kit env push --workers` | Every worker, GitHub skipped. Exclusive with `--all`, `--target` and `--github` |
| `kit env push --target <t>` / `--github` | One worker / GitHub only; both flags together push that worker and GitHub |
| `kit env rotate <KEY...> [--push]` | New generated value in `.env`, outputs re-rendered as `kit env sync` does, then prints where the key lives and the `kit env push …` to run; `--push` runs it |

`kit env rotate` only takes keys whose schema says how to make them:

```ts
INTERNAL_API_SECRET: z.string().min(32).meta({ generate: 'hex' }),             // 32 random bytes, hex
SESSION_KEY: z.string().meta({ generate: 'base64url', length: 48 }),           // length is in bytes
INSTALL_ID: z.uuid().meta({ generate: 'uuid' }),
```

- The new value is checked against the key's own rule before anything is written; only that line of
  `.env` changes (comments, order, quotes and line endings stay), and a key `.env` lacks is added.
- kit reads `.env` the way dotenv and Bun do: on an unquoted value ` #` starts a comment
  (`KEY=value # note` is `value`, `KEY= # note` is empty), a `#` inside `'…'`, `"…"` or backticks is
  part of the value, `"…"` turns `\n` / `\r` into line breaks, and `\$` is a literal `$`. kit itself
  never expands `$NAME`, but Bun (which loads `.env` before kit starts) does, so write a literal
  dollar as `\$`.
- When kit writes a value (`env init`, `env rotate`, rendered outputs) it quotes one that holds a
  `#`, has spaces at either end or starts with a quote, writes a multi-line value as `"…\n…"`, and in
  `.env` writes `$` as `\$` (`.dev.vars` keeps `$` raw: wrangler does not expand there). It refuses
  (exit 3, naming the key) a value no reader would get back intact: one that needs quotes and holds
  `'`, `"` and a backtick or ends in a backslash, a multi-line value holding `"` or a literal `\n`,
  and in `.env` one ending in `\$`. Base64-encode such a value.
- `kit env check`, `kit env push` and `kit doctor` warn about hand-written `.env` lines that Bun, dotenv
  and kit read differently (names and line numbers only): a `#` inside an unquoted value, an unescaped
  `$`, a quote that does not close on its line. What runs locally and what `kit env push` sends could
  differ there; the warning says how to write the line. `kit env check --json` lists them under
  `ambiguous`.
- It confirms first, since the old value stops working once the new one is pushed (`--yes` skips).
  `--dry-run` writes nothing and lists what would rotate and where it would be pushed.
- `--push` pushes every secret of the remotes that hold the key. The remotes are listed first (a
  remote kit cannot list stops the run, with `--yes` too) and one confirm covers rotating and pushing,
  so nothing is written until the push can go ahead.
- `--json` reports `{ rotated: [{ key, destinations }], pushed }`, never a value. When `.env` holds
  a new value that is not on its remotes yet, `pending` is the command that finishes the job; the
  same note goes to stderr.
- A key without `generate` belongs to a provider: rotate it there, update `.env`, then `kit env push`.

## Releases

kit owns the release flow; one shared `fastlane/Fastfile` (shipped in this package) runs the lanes.
Each app keeps a one-line Fastfile in its fastlane dir (`release.fastlaneDir`, default `gradle.root`,
then the repo root):

```ruby
import(ENV.fetch("KIT_FASTFILE") { UI.user_error!("Run fastlane via `kit fastlane ...` or `kit release ...`") })
```

No Appfile, Matchfile, Pluginfile or app Gemfile: inputs reach the lanes as `KIT_*` env vars, and
`kit init` installs kit's bundle (frozen, in `~/.cache/kit/bundle`).

| Command | Does |
| --- | --- |
| `kit version show` | Version names from `versions.file` and the last release tags |
| `kit version bump <patch\|minor\|major> [--platform ios\|android\|all\|<service>]` | Edit the TOML value, commit `chore(release): …`, push (`--no-push`, `--pr`) |
| `kit release ios\|android --track internal\|alpha\|beta\|prod` | Preflight → next build number from the store → confirm → build → upload → tag `<platform>/v<version>+<build>` |
| `kit release <service>` | `release.services.<name>`: build, deploy, tag `<name>/v<version>`. A service cannot be named after a release command (`ios`, `android`, `certs`, `status`, `promote`, `rollout`, `metadata`, `rollback`) |
| `kit release rollback <service> [--to <version-id>]` | Worker services only: `wrangler rollback`; tags stay put (see [Cloudflare workers](#cloudflare-workers)) |
| `kit release certs [--add]` | match `appstore`, readonly; `--add` creates only what this app is missing (never nuke) |
| `kit fastlane …` | fastlane with kit's env and the ASC/Play key files |
| `kit release status [ios\|android]` | The TOML version and the latest build per store track (`--json`) |
| `kit release promote <ios\|android> --from alpha\|beta --to beta\|prod` | Move a build the store already has to a later track: no rebuild, no upload |
| `kit release rollout <ios\|android> --percent <1-100>\|--halt\|--resume\|--complete` | Change the production rollout of the released build |

- `kit release status`: Android lists every Play track (version codes and release names); iOS lists
  `testflight` (one build list for every group) and `prod` (the live App Store build and its phased
  release state; `unknown` with a warning and `phasedError` when it could not be read, which is not
  the same as having none). A track the store will not answer for is `unknown` with a warning; the command fails
  only when a platform has no readable track.
- `kit release promote`: `--build` picks the build number / version code (default: the latest on the
  source track). It runs the branch check, the store credentials, `release.preflight` and the same
  confirmation as a release to `--to`. A promotion never tags: a tag names a build, not a track
  (release notes are computed from the last `<platform>/v*` tag), so the tag from the build's first
  release stands. When `<platform>/v<version>+<build>` is missing, kit warns and prints the `git tag`
  command to run on the commit that built it (`tagExisted` and `tagCommand` in `--json`); HEAD is not
  that commit.
  `--dry-run` prints the plan and runs nothing.
  - **Internal builds are never promoted** (`--from internal` exits 2): they are compiled with
    `KIT_INTERNAL` set, so a later track needs `kit release <platform> --track <track>`.
  - Android: `--rollout` (prod, default `release.android.prodRollout` or 0.1) and `--draft` work as in
    `kit release android`; `--notes` sets the changelog except on production.
  - iOS: `--app-version <x.y.z>` promotes a build from before a version bump (default: the TOML version);
    it is the lane's app version and the tag's version. On Android it is a usage error (the version
    code alone finds the release).
  - iOS: the build must be in the source tester group (`release.ios.testflightGroups.<from>`, default
    the track name). A build that never reached it, an internal build included, is refused with
    exit 1, `--build` or not; so is a destination group the app does not have.
  - iOS: the source group must receive its builds explicitly, as `kit release ios --track alpha|beta`
    distributes them. A group with automatic distribution (App Store Connect's default for an
    internal group) holds every upload, internal builds included, and kit cannot tell them apart
    there: promoting from it is refused. Turn automatic distribution off for that group, or point
    `release.ios.testflightGroups` at one without it.
  - iOS: `alpha → beta` distributes the build to `release.ios.testflightGroups.beta`;
    `→ prod` submits it for App Store review (phased, manual release) and requires `--notes`.
- `kit release rollout` takes exactly one action. `--percent`, `--resume` and `--complete` widen
  production exposure, so they use the `prod` confirmation: type `prod` locally (`--yes` doesn't skip),
  the `production` environment's reviewers in CI. `--halt` is the emergency brake: a prompt that
  `--yes` skips. `--dry-run` runs nothing.
  Android changes the production staged rollout; `--percent 100` completes it, and a halted rollout
  must be resumed before its percentage changes. Only a rollout in progress (or, for `--resume`, a
  halted one) is touched, never a draft; `--build <version code>` names the release when the track
  holds more than one, and the result names the version code that changed. A release halted at 100%
  has no staged rollout to resume: `--resume` says so, use `--complete`. The App Store has no percentage (a phased release
  follows Apple's 7-day schedule), so `--percent` is a usage error on iOS: `--halt` pauses the phased
  release, `--resume` and `--complete` do what they say.
- Build numbers are never committed: `max(store) + 1`, or `--build` / `--code`.
- iOS: set `release.ios.xcconfig` to the xcconfig holding `MARKETING_VERSION` (what local Xcode builds
  show). `kit version bump` rewrites it in the same commit, and `kit release ios` / `kit doctor` fail
  if it ever differs from the TOML.
- Secrets: `kit doctor` warns about missing release secrets for each configured platform (`kit release`
  itself stops on them). `kit env check` fails when GitHub lacks a name from `env.githubSecrets`, or a
  release secret when a workflow releases; repo, environment and org secrets count. It flags old names
  (`APPLE_*`, `FIREBASE_*`) to delete.
- Confirmation: `internal` none; `alpha`/`beta` a prompt (`--yes` skips); `prod` asks you to type `prod`
  locally (`--yes` doesn't skip) and in CI relies on the `production` environment's reviewers.
- `--dry-run` runs preflight and the build, never uploads or tags.
- Notes default to commit subjects since the last `<platform>/v*` tag (else the last 20); Play notes
  are clamped to 500 chars. iOS `prod` requires `--notes` (App Store What's New).

Secrets (canonical names, from `.env` or the CI job): `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`,
`MATCH_PASSWORD`, `MATCH_GIT_URL`, `MATCH_GIT_BASIC_AUTHORIZATION` (CI), `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`, `PLAY_SERVICE_ACCOUNT_BASE64`, `SENTRY_AUTH_TOKEN`.
Files are decoded into a 0600 temp dir removed on exit; values are redacted from output.

### Preflight checks

`release.preflight` lists modules run before every mobile release:

```ts
// .kit/preflight/seed.ts
import { definePreflight, KitError } from '@jordond/kit'

export default definePreflight({
  title: 'seed matches the deployed deck',
  skipFlag: 'seed-check', // kit release ios --skip seed-check
  platforms: ['ios', 'android'],
  async check(ctx, { platform, track, version }) {
    if (/* stale */ false) throw new KitError('seed is stale', 'run `kit seed pull`')
  },
})
```

`release.android.gates` run Gradle tasks for the listed tracks (e.g. baseline-profile verification).

### Store listing

`kit release metadata` keeps the store listing in the repo, in fastlane's own layouts. Both keys are
optional paths relative to the repo root:

```ts
release: {
  ios: { /* … */ metadata: 'client/fastlane/metadata' }, // deliver: <locale>/name.txt, …; screenshots in ../screenshots
  android: { /* … */ metadata: 'client/fastlane/metadata/android' }, // supply: <locale>/title.txt, <locale>/images/
},
```

| Command | Does |
| --- | --- |
| `kit release metadata pull <ios\|android> [--screenshots] [--force]` | Download the listing text; `--screenshots` also downloads the screenshots (Play: and the feature graphic and icon) |
| `kit release metadata push <ios\|android> [--screenshots] [--only-screenshots]` | Upload the listing text; `--screenshots` also replaces the screenshots (Play: and the feature graphic and icon); `--only-screenshots` sends the images and no text |

- `push` never uploads a binary, submits for review, or changes a rollout or phased release. It asks
  before changing the public listing (`--yes` skips); `--dry-run` prints the files it would send and
  runs nothing.
- `pull` stops when what it would write has uncommitted changes (the text; with `--screenshots` the
  screenshots too); `--force` overwrites them. Without `--screenshots` local screenshots are left alone.
- iOS `review_information/` (the App Review contact and the demo account's user and password, which
  deliver writes as plaintext) never stays in the repo: `pull` removes it, and `push` neither lists nor
  uploads it. Edit those fields in App Store Connect.
- Only the store key is needed: `ASC_*` for iOS, `PLAY_SERVICE_ACCOUNT_BASE64` for Android.
- iOS edits the version being prepared in App Store Connect; with none, `push` fails at once: create
  the next version there, or push after `kit release ios --track prod`. Android needs a
  release on some Play track, and `changelogs/` is never sent: `kit release android` writes those.
- A missing key or directory is a usage error (exit 2) naming `release.<platform>.metadata`.

#### Screenshots

`kit release metadata push <ios|android> --screenshots` uploads the listing text and the images.
`--only-screenshots` uploads the images alone: no text is sent, none has to exist in the repo, and the
store keeps the text it has. Use it after `kit shots export`.

One thing is still added on iOS: deliver creates a version localization for every local screenshot
locale the version being prepared lacks. `--only-screenshots` with a new `fr-FR/` directory adds a
fr-FR locale to that version with no text in it; fill it in App Store Connect or with a text push
before submitting.

```sh
kit release metadata push ios --only-screenshots --dry-run   # check the images, upload nothing
kit release metadata push ios --only-screenshots
kit release metadata push android --screenshots --yes
```

kit finds the images the way fastlane does, so what it checks, lists and counts is what goes up:

| Store | Uploaded | Not uploaded |
| --- | --- | --- |
| App Store (deliver) | The `.png`, `.jpg` and `.jpeg` files directly in `screenshots/<locale>/`, and in `screenshots/appleTV/<locale>/` and `screenshots/iMessage/<locale>/` | Files at the root of `screenshots/`, in deeper directories, and in `fonts/`, `android/` and `review_information/`. In a locale directory with a `*_framed` file, every file whose path names neither "framed" nor "watch" |
| Google Play (supply) | `<locale>/images/featureGraphic.<ext>`, `icon.<ext>` and `tvBanner.<ext>`, and the files directly in `<locale>/images/phoneScreenshots/`, `sevenInchScreenshots/`, `tenInchScreenshots/`, `tvScreenshots/` and `wearScreenshots/` | Any other file or directory under `<locale>/images/` |

Every other directory in `screenshots/` must be named after an App Store locale, in any case. The
names are deliver's list in the pinned fastlane: `ar-SA`, `bn-BD`, `ca`, `cs`, `da`, `de-DE`, `el`,
`en-AU`, `en-CA`, `en-GB`, `en-US`, `es-ES`, `es-MX`, `fi`, `fr-CA`, `fr-FR`, `gu-IN`, `he`, `hi`, `hr`,
`hu`, `id`, `it`, `ja`, `kn-IN`, `ko`, `ml-IN`, `mr-IN`, `ms`, `nl-NL`, `no`, `or-IN`, `pa-IN`, `pl`,
`pt-BR`, `pt-PT`, `ro`, `ru`, `sk`, `sl-SI`, `sv`, `ta-IN`, `te-IN`, `th`, `tr`, `uk`, `ur-PK`, `vi`,
`zh-Hans`, `zh-Hant`. Two layouts stop the push with exit 4, because deliver would fail on them, the
second one after deleting the store's screenshots:

- a directory with another name, such as `screenshots/en/`;
- `screenshots/default/`, or `default`, `appleTV` or `iMessage` inside `appleTV/` or `iMessage/`,
  when it holds an image: deliver reads its files with no locale. Without one it is left alone.

An image push also stops with exit 4 when the absolute path of the screenshots directory (iOS) or
the metadata directory (Android) contains one of `[ ] { } * ? \`: fastlane cannot read such a path.
deliver and supply find the images with a glob, read these characters as a pattern, upload nothing
and report success. Of several files for one Play image type (`icon.png` beside `icon.jpg`) supply
uploads the last of `png`, `jpg`, `jpeg`, and that one is the file kit checks.

Before the confirmation (and in `--dry-run`) kit reads every image it is about to upload. If the store
would refuse any of them, the push stops with exit 4 and lists each file with its reason; nothing is
uploaded and kit never rewrites the files. A directory or a dangling link with an image name is listed
too: fastlane would still try to upload it.

| Store | Rule |
| --- | --- |
| Both | The file is a PNG or JPEG and its content matches its extension; no alpha channel |
| App Store | The pixel size is one App Store Connect takes; at most 10 screenshots per locale and display type. A file in `iMessage/<locale>/` is an iMessage display type: its own count, and no Mac, Watch, Apple TV or Vision Pro sizes |
| Google Play screenshots | Each side 320 to 3840 px; the long side at most twice the short side; at most 8 per type and locale. Fewer than 2 phone screenshots is a warning |
| Google Play images | `featureGraphic` is exactly 1024x500 and `tvBanner` exactly 1280x720, both with no alpha; `icon` is 512x512 and at most 1024 KB (alpha allowed) |

The confirmation shows, per locale and class, how many images go up and at what size. With `--json`
the document carries `files` (what goes up), `images` (`file`, `locale`, `class`, `width`, `height`
for each image that could be read), `problems` (what stopped the push) and `warnings` (what did not,
such as a single Play phone screenshot); the last three are empty arrays on a text-only push.

**An iOS screenshot push replaces whole locales.** For each locale that has local screenshots, every
screenshot set of that locale is deleted from the App Store before the new ones upload, including
sets you have no local files for: a locale with only iPhone screenshots in the repo loses its iPad
set. The confirmation names the locales ("replaces every screenshot set of: en-US, fr-FR"). Google
Play replaces only the screenshot types that have local files, and applies the change in one commit.

### CI

`.github/workflows/mobile-distribute.yml` is a reusable workflow. Pin it by SHA and pass named secrets:

```yaml
on:
  workflow_dispatch:
    inputs:
      track: { type: choice, options: [internal, alpha, beta, prod], default: internal }
jobs:
  ios:
    uses: jordond/kit/.github/workflows/mobile-distribute.yml@<sha> # vX.Y.Z
    permissions: { contents: write }
    with: { platform: ios, track: ${{ inputs.track }} }
    secrets:
      ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
      ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
      ASC_KEY_P8_BASE64: ${{ secrets.ASC_KEY_P8_BASE64 }}
      MATCH_PASSWORD: ${{ secrets.MATCH_PASSWORD }}
      MATCH_GIT_URL: ${{ secrets.MATCH_GIT_URL }}
      MATCH_GIT_BASIC_AUTHORIZATION: ${{ secrets.MATCH_GIT_BASIC_AUTHORIZATION }}
      SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
```

The same workflow promotes and changes rollouts through `operation` (default `release`):

| `operation` | Runs | Inputs |
| --- | --- | --- |
| `release` | `kit release <platform> --track <track>` | `track`, `build`, `notes`, `rollout`, `draft`, `skip` |
| `promote` | `kit release promote <platform> --from <from> --to <track>` | `from`, `track` (the destination), `build`, `app-version`, `notes`, `rollout`, `draft`, `skip` |
| `rollout` | `kit release rollout <platform> --<rollout-action>` | `rollout-action` (`percent`, `halt`, `resume`, `complete`), `percent`, `build` |

```yaml
  promote:
    uses: jordond/kit/.github/workflows/mobile-distribute.yml@<sha> # vX.Y.Z
    permissions: { contents: write }
    with: { operation: promote, platform: android, from: beta, track: prod }
    secrets:
      PLAY_SERVICE_ACCOUNT_BASE64: ${{ secrets.PLAY_SERVICE_ACCOUNT_BASE64 }}
```

The job runs in the `production` environment for a release or promote to `prod` and for every
rollout, so its required reviewers approve whatever widens production. That is the gate kit relies on
when it skips the typed `prod` confirmation on GitHub Actions: run `kit release promote --to prod` and
`kit release rollout` in CI through this workflow, or from a job that sets `environment: production`.

### Lane tests

The shared Fastfile's selection logic (which build a promotion moves, which Play release a rollout
changes, tester-group resolution) has Ruby tests that run it against stubbed store objects:

```sh
ruby test/fastlane/run.rb
```

They need only Ruby and its bundled minitest, not kit's fastlane bundle. `bun test` runs them too
(`test/e2e/fastlane-lanes.test.ts`), plus a `fastlane lanes` parse of the Fastfile when the bundle is
installed; each part is skipped when its tool is missing.

## Cloudflare workers

For targets of kind `worker`. Every command runs wrangler from the target's directory with
`CLOUDFLARE_ACCOUNT_ID` pinned from `cloudflare.accountId`.

| Command | Does |
| --- | --- |
| `kit deploy <target> --preview [--comment]` | `wrangler versions upload`: a new version, production traffic untouched. The preview URL is the only thing on stdout (`--json`: `{ ok, target, url, version }`) |
| `kit release rollback <service> [--to <version-id>]` | `wrangler rollback` to the last deployment with different code, for a service whose `deploy` is `kit deploy <worker target>`; confirms first (`--yes` skips) |
| `kit logs <target> [-- <wrangler tail flags>]` | `wrangler tail`, attached to the terminal; Ctrl-C stops |
| `kit open <target> [--print]` | The worker's Cloudflare dashboard page; `--print` or `--json` writes the URL instead |
| `kit db backup [--remote] [--out <file>]` | `wrangler d1 export` to `backups/<db>-<UTC timestamp>.sql`; prints the path |
| `kit db restore <file> [--remote]` | Load a backup: locally it replaces the database; remotely the database must be empty |
| `kit db seed [--remote]` | Run the file named by `cloudflare.d1.<db>.seed` (relative to the repo root) |
| `kit db reset` | Local only: delete the local database, re-apply migrations, then seed if configured |

- `--preview` takes one worker target, honours `--env` and `deploy.before`, and aliases the preview
  to the branch (`feat/login` → `feat-login-<worker>.<subdomain>.workers.dev`); with no usable branch
  name the URL is the per-version one. A target with a custom `deploy` command runs its `build`
  first (and needs one: exit 2 otherwise); `deploy: false` has no preview.
- `--comment` posts the URL on the branch's pull request with `gh`, and on the next preview updates
  that comment: only one the `gh` user wrote that opens with kit's marker. With no pull request it
  warns; any other `gh` failure exits 1, after the URL is printed (`comment: 'failed'`, `ok: false`).
- `kit release rollback` works out the version itself: every `wrangler secret put` (`kit env push`)
  is a deployment, so "the previous deployment" would only undo the last secret. kit picks the last
  deployment whose code differs from what is live, shows its id and date, and warns when secrets
  changed since then: their values go back too, so run `kit env push` afterwards. `--to` names a
  version outright, and is required while a gradual deployment is live (exit 4 lists the candidates). Git tags are never moved or deleted: it names the `<service>/v*` tag that no
  longer matches production. A service whose deploy is not a worker exits 2.
- `kit db restore`: a backup carries the schema and the applied-migrations table, so it loads into
  an empty database only. Locally kit deletes the database first (after a confirm, like `reset`).
  Remotely it checks the database has no tables and exits 4 naming them if it does; kit never drops
  remote tables.
- `kit db backup` warns when git does not ignore the file it wrote: a `--remote` dump is production
  data. `kit init` adds `backups/` to `.gitignore`.
- `kit db reset` and a local restore stop (exit 1, "layout not recognised") rather than report a
  reset that deleted nothing, when wrangler's local state is not where kit expects it.
- `kit db` commands take `--db`; `--remote` writes (`restore`, `seed`) confirm first, and
  `kit db reset --remote` is a usage error.
- `kit logs` has no `--json` document (exit 2): for JSON lines use `kit logs <target> -- --format json`.
- `--dry-run` runs nothing in any of them.

## Working on kit

kit runs on Bun and is checked and built with [Vite+](https://viteplus.dev) (`vp`). `vp` is a Node
program, so a checkout needs Node `^22.18`, `^24.11` or `>=26` next to Bun; a globally installed `vp`
installs Node itself.

| Command | Does |
| --- | --- |
| `bun run check` | Format check, lint and type check in one pass (`vp check`); warnings fail |
| `bun run format` | Rewrite files with the formatter (`vp fmt`) |
| `bun run lint` | Lint only (`vp lint`) |
| `bun test` | Tests. They run on Bun, not on `vp test` |
| `bun run build` | Bundle `dist/` and its declarations (`vp pack`) |
| `bun run test:pack` | Install the packed tarball into a temp app and run it |

`KIT_DEV=<checkout>` makes the `kit` launcher run that checkout's sources.
