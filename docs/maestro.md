# Maestro: QA and screenshots

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
  version: '2.12.1',                      // kit doctor compares it; CI installs it
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

**The run.** One device is resolved first (see [Devices](devices.md)), then everything lands on it: the debug
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
against `maestro.version` and that Java 17+ is there. `kit add maestro` writes a starter flows directory.

## Maestro in CI

`.github/workflows/mobile-qa.yml` is a reusable workflow that runs `kit qa`: an iOS simulator on a macOS
runner and an Android emulator on a Linux runner with KVM, one job each (an Android emulator cannot run on
an arm64 macOS runner). Pin it by SHA like `mobile-distribute.yml`:

```yaml
on:
  pull_request:
jobs:
  qa:
    uses: jordond/kit/.github/workflows/mobile-qa.yml@<sha> # vX.Y.Z
    with:
      platform: both # ios | android | both
      suite: '' # a maestro.suites entry; empty = qa
      android-api: '36'
      # API 37 images need these; same as devices.android.emulatorArgs in kit.config.ts
      # emulator-args: -feature -HardwareDecoder
```

| Input                              | Default                         | Meaning                                                                                                                                                      |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform`                         | `both`                          | `ios`, `android` or `both`                                                                                                                                   |
| `suite`                            | empty                           | `kit qa --suite`; empty runs the `qa` suite                                                                                                                  |
| `android-api`                      | `36`                            | API level of the Google Play system image the emulator uses                                                                                                  |
| `ios-device`                       | empty                           | Simulator name to boot first. Empty skips the explicit boot, so `kit qa ios` uses `maestro.devices.ios`, else the newest, largest iPhone                     |
| `emulator-args`                    | empty                           | Extra emulator arguments (`KIT_EMULATOR_ARGS`), after `devices.android.emulatorArgs`                                                                         |
| `device-timeout-ms`                | `600000`                        | How long kit waits for a device to boot (`KIT_DEVICE_TIMEOUT_MS`)                                                                                            |
| `maestro-version`                  | empty                           | Empty reads `maestro.version` from the config                                                                                                                |
| `bun-version`, `java-version`      | `1.3.14`, `21`                  | Tool versions; Java serves Gradle and Maestro (17 or newer)                                                                                                  |
| `ios-runner`, `android-runner`     | `macos-latest`, `ubuntu-latest` | Runner labels                                                                                                                                                |
| `artifact-name`, `timeout-minutes` | `qa`, `60`                      | Artifact prefix, job timeout. Artifacts are `<prefix>-<suite>-<platform>` (`qa-qa-ios`, `qa-nightly-android`), so calls with different suites do not collide |

Each job installs the repo's dependencies and Java and Gradle, installs Maestro at the pinned version, then
runs `kit qa`, which boots the device when none is running. On Linux the workflow installs only the chosen
API's Google Play system image and kit creates the AVD on it (fixtures go through `run-as`, never `adb root`);
`maestro.devices.android` names an AVD instead. Both jobs upload the Maestro run directories (`maestro.output`,
default `<maestro.dir>/output`) and a JUnit report as an artifact, pass or fail; the Android artifact also holds
the emulator log, which is what explains a boot that hung. The repo needs a `maestro` block in `kit.config.ts` and an app kit can build; the workflow takes no secrets, so a
build that needs some is not covered yet. It has not been run on a hosted runner.

Turning the raw shots into store images: [Store screenshots](shots.md).
