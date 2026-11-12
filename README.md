# kit

One dev toolkit for every app: the `kit` CLI, a shared fastlane setup, and Gradle conventions, shipped
together as `@jordond/kit`.

```sh
bun add -d @jordond/kit
kit --help
```

Install it globally too (`bun add -g @jordond/kit`) to get `kit` on your `PATH`: the global launcher finds
the nearest `kit.config.ts` and runs that repo's own pinned copy.

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
| `toolchain` | `.kit/package.json`, `.kit/kit.config.ts`, `fastlane/Fastfile`, `.env.example`, `.editorconfig` (ktlint, 2-space), `mise.toml` (bun + ktlint, no java), `lefthook.yml`, `.github/workflows/{ci,distribute}.yml`; adds `node_modules/` and `.env` to `.gitignore` and `app-android-version` / `app-ios-version` to `libs.versions.toml` |
| `gradle` | root `package.json`, `kit.config.ts`, `apps/client/{settings.gradle.kts,gradle/libs.versions.toml,fastlane/Fastfile}`, `.env.example`, `mise.toml`, `lefthook.yml`, `.github/workflows/ci.yml`. Add the Gradle wrapper and the modules yourself |

- `toolchain` layers kit over an existing project and never writes a root `package.json`. Create the project
  first (`kotlin init`). A plain `kit init` there offers the template (`--yes` accepts it).
- It reads the project to fill the config: the `android/app` module and its `applicationId`, the `ios/app`
  module's Xcode project, scheme, bundle id, team and the xcconfig holding `MARKETING_VERSION`, and the
  `jvm/app` module for `kit dev`. An id it cannot find is `com.example.<name>`: replace it before a release.
  CI tests the non-Apple platforms the modules declare (`--platform jvm --platform android …`).
- Workflows pin kit by the commit of the running version's tag (`@<sha> # vX.Y.Z`).
- A file that already exists is kept; `.gitignore` and the catalog only gain lines.

## Upgrading

```sh
kit upgrade            # the latest release on npm
kit upgrade 0.6.0
```

Moves the `@jordond/kit` range in `package.json` (or `.kit/package.json`), runs the install, and rewrites
every `jordond/kit/…@<sha> # vX.Y.Z` in `.github/workflows` to that release's tag commit, which is what
`kit doctor --ci` compares. Re-running it repairs workflow pins that lag the npm pin.

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
`release.ios.output` dir. `--deep` adds `node_modules` (root and `.kit/`), `.wrangler/state` (your local
D1/KV data) and the configured iOS project's Xcode DerivedData. It lists every path with its size and asks
first (`--yes` skips the question); `--json` reports `{ removed: [{ path, bytes }], bytes }`. Symlinks
and anything that resolves outside the repo root are refused.

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
| `kit release <service>` | `release.services.<name>`: build, deploy, tag `<name>/v<version>` |
| `kit release certs [--add]` | match `appstore`, readonly; `--add` creates only what this app is missing (never nuke) |
| `kit fastlane …` | fastlane with kit's env and the ASC/Play key files |
| `kit release status [ios\|android]` | The TOML version and the latest build per store track (`--json`) |
| `kit release promote <ios\|android> --from alpha\|beta --to beta\|prod` | Move a build the store already has to a later track: no rebuild, no upload |
| `kit release rollout <ios\|android> --percent <1-100>\|--halt\|--resume\|--complete` | Change the production rollout of the released build |

- `kit release status`: Android lists every Play track (version codes and release names); iOS lists
  `testflight` (one build list for every group) and `prod` (the live App Store build and its phased
  release state). A track the store will not answer for is `unknown` with a warning; the command fails
  only when a platform has no readable track.
- `kit release promote`: `--build` picks the build number / version code (default: the latest on the
  source track). It runs the branch check, the store credentials, `release.preflight` and the same
  confirmation as a release to `--to`, then tags `<platform>/v<version>+<build>` unless that tag exists.
  A promotion gets no tag of its own: a tag names a build, not a track, and release notes are computed
  from the last `<platform>/v*` tag.
  `--dry-run` prints the plan and runs nothing.
  - **Internal builds are never promoted** (`--from internal` exits 2): they are compiled with
    `KIT_INTERNAL` set, so a later track needs `kit release <platform> --track <track>`.
  - Android: `--rollout` (prod, default `release.android.prodRollout` or 0.1) and `--draft` work as in
    `kit release android`; `--notes` sets the changelog except on production.
  - iOS: `--app-version <x.y.z>` promotes a build from before a version bump (default: the TOML version);
    it is the lane's app version and the tag's version. On Android it is a usage error (the version
    code alone finds the release).
  - iOS: `alpha → beta` distributes the TestFlight build to `release.ios.testflightGroups.beta`;
    `→ prod` submits it for App Store review (phased, manual release) and requires `--notes`.
- `kit release rollout` takes exactly one action. `--percent`, `--resume` and `--complete` widen
  production exposure, so they use the `prod` confirmation: type `prod` locally (`--yes` doesn't skip),
  the `production` environment's reviewers in CI. `--halt` is the emergency brake: a prompt that
  `--yes` skips. `--dry-run` runs nothing.
  Android changes the production staged rollout; `--percent 100` completes it, and a halted rollout
  must be resumed before its percentage changes. The App Store has no percentage (a phased release
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
