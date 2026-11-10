# kit

One dev toolkit for every app: the `kit` CLI, a shared fastlane setup, and Gradle conventions, shipped
together as `@jordond/kit`.

```sh
bun add -d @jordond/kit
kit --help
```

## Shell completion

```sh
source <(kit completion zsh)                                  # ~/.zshrc, after compinit
source <(kit completion bash)                                 # ~/.bashrc
kit completion fish > ~/.config/fish/completions/kit.fish
```

The script calls back into the `kit` on your `PATH`, so it follows each repo's pinned version and
works outside a repo too.

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
- Secrets: `kit doctor` checks the release secrets for each configured platform (warns locally, fails
  on GitHub Actions); `kit env check` compares `gh secret list` with `env.githubSecrets` plus those
  release secrets and flags old names (`APPLE_*`, `FIREBASE_*`) to delete.
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
