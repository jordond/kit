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

```sh
kit doctor --fix             # list the fixes, confirm once, apply, check again
kit doctor --fix --yes       # no question (needed without a terminal)
kit doctor --fix --dry-run   # list them only
```

`--fix` repairs what is safe and local, then reports (and exits on) the state after the fixes:

| Check | Fix |
| --- | --- |
| lefthook hook not installed | `lefthook install` |
| mise tool missing or drifted | `mise install` |
| wrangler not installed | the package manager's install (`bun install`, `pnpm install`, …) |
| iOS / Android version drift | writes the TOML version to the xcconfig's `MARKETING_VERSION` / the module.yaml's `versionName` |
| Kotlin toolchain wrapper not executable | `chmod +x` |
| workflow pins behind the npm pin | moves them to that release's tag commit, as `kit upgrade` does; skipped with a note when the tag cannot be resolved (offline) |

Xcode, the JDK, the Android SDK, logins, `.env` values and secrets are never fixed: those checks keep
their hint. Plain `kit doctor` ends with `N fixable with kit doctor --fix` when there is something to
apply, and `--json` adds `fixes: [{ id, description, applied, ok, error? }]`.

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
the heading is `## ios 1.4.0 (…)`. A version that already has a section is not added again.
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
