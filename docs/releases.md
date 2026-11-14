# Releases

kit owns the release flow; one shared `fastlane/Fastfile` (shipped in this package) runs the lanes.
Each app keeps a one-line Fastfile in its fastlane dir (`release.fastlaneDir`, default `gradle.root`,
then the repo root):

```ruby
import(ENV.fetch("KIT_FASTFILE") { UI.user_error!("Run fastlane via `kit fastlane ...` or `kit release ...`") })
```

No Appfile, Matchfile, Pluginfile or app Gemfile: inputs reach the lanes as `KIT_*` env vars, and
`kit init` installs kit's bundle (frozen, in `~/.cache/kit/bundle`).

| Command                                                                              | Does                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit version show`                                                                   | Version names from `versions.file` and the last release tags                                                                                                                                                         |
| `kit version bump <patch\|minor\|major> [--platform ios\|android\|all\|<service>]`   | Edit the TOML value, commit `chore(release): …`, push (`--no-push`, `--pr`)                                                                                                                                          |
| `kit release ios\|android --track internal\|alpha\|beta\|prod`                       | Preflight → next build number from the store → confirm → build → upload → tag `<platform>/v<version>+<build>`                                                                                                        |
| `kit release <service>`                                                              | `release.services.<name>`: build, deploy, tag `<name>/v<version>`. A service cannot be named after a release command (`ios`, `android`, `certs`, `keystore`, `status`, `promote`, `rollout`, `metadata`, `rollback`) |
| `kit release rollback <service> [--to <version-id>]`                                 | Worker services only: `wrangler rollback`; tags stay put (see [Cloudflare workers](cloudflare.md))                                                                                                                   |
| `kit release certs [--add]`                                                          | match `appstore`, readonly; `--add` creates only what this app is missing (never nuke)                                                                                                                               |
| `kit release keystore [--alias key0] [--github]`                                     | Create the Android upload keystore, write `ANDROID_KEYSTORE_*` to `.env` and GitHub Actions secrets (see [Android upload key](#android-upload-key))                                                                  |
| `kit fastlane …`                                                                     | fastlane with kit's env and the ASC/Play key files                                                                                                                                                                   |
| `kit release status [ios\|android]`                                                  | The TOML version and the latest build per store track (`--json`)                                                                                                                                                     |
| `kit release promote <ios\|android> --from alpha\|beta --to beta\|prod`              | Move a build the store already has to a later track: no rebuild, no upload                                                                                                                                           |
| `kit release rollout <ios\|android> --percent <1-100>\|--halt\|--resume\|--complete` | Change the production rollout of the released build                                                                                                                                                                  |

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

## Android upload key

`kit release keystore` sets up Android signing for an app that has no upload key yet:

1. Creates a keystore with one key (alias `key0`, `--alias` to change) and a generated password, used
   for both store and key. A Kotlin toolchain repo runs `./kotlin tool generate-keystore`; a Gradle
   repo runs `keytool` (PKCS12, RSA 2048). The file goes to `~/.keystores/<name>.keystore`, outside the
   repo (`--out` to change).
2. Writes `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_ALIAS` and `ANDROID_KEYSTORE_PASSWORD` to `.env`.
3. Sets the same three as GitHub Actions secrets with `gh`: `--github` does it, `--no-github` skips it,
   and without either kit asks in a terminal (`--yes` answers yes) and skips elsewhere.
4. Prints the keystore path, alias and password. `.env` then holds the whole key (the keystore as
   base64, the alias and the password), so the keystore can be rebuilt from it; GitHub secrets cannot be
   read back. Keep a copy off the machine: losing both `.env` and the keystore file needs an upload-key
   reset in Play Console.

It never overwrites a keystore file, and refuses when `.env` already holds `ANDROID_KEYSTORE_*` values
unless `--force`. `--dry-run` shows the plan; `--json` includes the password in the document.

Nothing else is needed for a Kotlin toolchain app: `kit release android` writes
`settings.android.signing` into `module.yaml` for the build. A Gradle app module must apply
`io.github.jordond.kit.release`, which reads these variables; the command warns when it does not.

## Preflight checks

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

## Store listing

`kit release metadata` keeps the store listing in the repo, in fastlane's own layouts. Both keys are
optional paths relative to the repo root:

```ts
release: {
  ios: { /* … */ metadata: 'client/fastlane/metadata' }, // deliver: <locale>/name.txt, …; screenshots in ../screenshots
  android: { /* … */ metadata: 'client/fastlane/metadata/android' }, // supply: <locale>/title.txt, <locale>/images/
},
```

| Command                                                                         | Does                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kit release metadata pull <ios\|android> [--screenshots] [--force]`            | Download the listing text; `--screenshots` also downloads the screenshots (Play: and the feature graphic and icon)                                                 |
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

### Screenshots

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

| Store                | Uploaded                                                                                                                                                                                                                          | Not uploaded                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Store (deliver)  | The `.png`, `.jpg` and `.jpeg` files directly in `screenshots/<locale>/`, and in `screenshots/appleTV/<locale>/` and `screenshots/iMessage/<locale>/`                                                                             | Files at the root of `screenshots/`, in deeper directories, and in `fonts/`, `android/` and `review_information/`. In a locale directory with a `*_framed` file, every file whose path names neither "framed" nor "watch" |
| Google Play (supply) | `<locale>/images/featureGraphic.<ext>`, `icon.<ext>` and `tvBanner.<ext>`, and the files directly in `<locale>/images/phoneScreenshots/`, `sevenInchScreenshots/`, `tenInchScreenshots/`, `tvScreenshots/` and `wearScreenshots/` | Any other file or directory under `<locale>/images/`                                                                                                                                                                      |

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

| Store                   | Rule                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both                    | The file is a PNG or JPEG and its content matches its extension; no alpha channel                                                                                                                                             |
| App Store               | The pixel size is one App Store Connect takes; at most 10 screenshots per locale and display type. A file in `iMessage/<locale>/` is an iMessage display type: its own count, and no Mac, Watch, Apple TV or Vision Pro sizes |
| Google Play screenshots | Each side 320 to 3840 px; the long side at most twice the short side; at most 8 per type and locale. Fewer than 2 phone screenshots is a warning                                                                              |
| Google Play images      | `featureGraphic` is exactly 1024x500 and `tvBanner` exactly 1280x720, both with no alpha; `icon` is 512x512 and at most 1024 KB (alpha allowed)                                                                               |

The confirmation shows, per locale and class, how many images go up and at what size. With `--json`
the document carries `files` (what goes up), `images` (`file`, `locale`, `class`, `width`, `height`
for each image that could be read), `problems` (what stopped the push) and `warnings` (what did not,
such as a single Play phone screenshot); the last three are empty arrays on a text-only push.

**An iOS screenshot push replaces whole locales.** For each locale that has local screenshots, every
screenshot set of that locale is deleted from the App Store before the new ones upload, including
sets you have no local files for: a locale with only iPhone screenshots in the repo loses its iPad
set. The confirmation names the locales ("replaces every screenshot set of: en-US, fr-FR"). Google
Play replaces only the screenshot types that have local files, and applies the change in one commit.

## CI

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
    with: { platform: ios, track: $, { { inputs.track } } }
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

| `operation` | Runs                                                        | Inputs                                                                                         |
| ----------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `release`   | `kit release <platform> --track <track>`                    | `track`, `build`, `notes`, `rollout`, `draft`, `skip`                                          |
| `promote`   | `kit release promote <platform> --from <from> --to <track>` | `from`, `track` (the destination), `build`, `app-version`, `notes`, `rollout`, `draft`, `skip` |
| `rollout`   | `kit release rollout <platform> --<rollout-action>`         | `rollout-action` (`percent`, `halt`, `resume`, `complete`), `percent`, `build`                 |

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
