# Scaffolding: `kit init` and `kit add`

## New repos

`kit init` in a repo without a `kit.config.ts` can write the kit files first, then set the clone up as
usual (`.env`, install, toolchain download, fastlane bundle). Run it with a global kit or `bunx @jordond/kit init`.

```sh
kit init --template toolchain          # in a Kotlin toolchain project (a `kotlin` wrapper + project.yaml)
kit init --template gradle --name MyApp
kit init --template toolchain --dry-run
```

| Template    | Writes                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolchain` | `.kit/package.json`, `.kit/kit.config.ts`, `fastlane/Fastfile`, `.env.example`, `.editorconfig` (ktlint, 2-space), `mise.toml` (bun + ktlint, no java), `lefthook.yml`, `.github/workflows/{ci,distribute}.yml`, `renovate.json`; adds `node_modules/` and `.env` to `.gitignore` and `app-android-version` / `app-ios-version` to `libs.versions.toml` |
| `gradle`    | root `package.json`, `kit.config.ts`, `apps/client/{settings.gradle.kts,gradle/libs.versions.toml,fastlane/Fastfile}`, `.env.example`, `mise.toml`, `lefthook.yml`, `.github/workflows/ci.yml`, `renovate.json`. Add the Gradle wrapper and the modules yourself                                                                                        |

- `toolchain` layers kit over an existing project and never writes a root `package.json`. Create the project
  first (`kotlin init`). A plain `kit init` there offers the template (`--yes` accepts it).
- It reads the project to fill the config: the `android/app` module and its `applicationId`, the `ios/app`
  module's Xcode project, scheme, bundle id, team and the xcconfig holding `MARKETING_VERSION`, and the
  `jvm/app` module for `kit dev`. An id it cannot find is `com.example.<name>`: replace it before a release.
  CI tests the non-Apple platforms the modules declare (`--platform jvm --platform android …`).
- Workflows pin kit by the commit of the running version's tag (`@<sha> # vX.Y.Z`).
- A file that already exists is kept; `.gitignore` and the catalog only gain lines. `renovate.json` is
  skipped when the repo has a Renovate config anywhere (`.github/renovate.json`, `.renovaterc`, …).

## Adding modules, targets and Maestro flows

`kit add` scaffolds into a repo that already has kit. Every command shows the plan first, writes nothing
with `--dry-run`, and prints the plan or result as one document with `--json`.

```sh
kit add module core                              # KMP library: android, ios, jvm
kit add module feature:login --compose           # <gradle root>/feature/login, plus kit.compose
kit add module data --targets android,jvm --dir libs/data
kit add target api --kind worker --dir apps/api  # worker | vite | astro | docker | custom
kit add maestro                                  # starter flows, settle subflow, README with the rules
```

|                                | Gradle (`gradle.root`)                                                                                                                                                                             | Kotlin toolchain (`toolchain.root`)                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `kit add module <name>` writes | `build.gradle.kts` on kit's plugins only (`io.github.jordond.kit.kmp.library`, `…kit.compose` with `--compose`) with `kit { targets { … } }`, and `src/commonMain/kotlin/<package>/Placeholder.kt` | `module.yaml` (`kmp/lib`, the platforms of `--targets`; `--compose` enables Compose) and `src/Placeholder.kt` |
| and registers it in            | `settings.gradle.kts`: one `include(":<name>")` after the last include (plus a `projectDir` line when `--dir` is not the path)                                                                     | `project.yaml`: one entry in `modules:`, in the list's own style                                              |
| Package                        | catalog `app-name` + the module path, the same rule the plugin uses for the Android namespace (`:feature:login` → `<app-name>.feature.login`)                                                      | the Android `applicationId` (or iOS bundle id) + the module name                                              |

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
- `kit add maestro [--dir <path>] [--ios <bundle id>] [--android <package>]` writes the starter Maestro
  flows (see [Maestro: QA and screenshots](maestro.md)); its own rules are below.

### `kit add maestro`

| File (under the flows dir) | Holds                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.yaml`              | `flows: [flows/*]`, so `maestro test` never runs a subflow as a flow                                                                                               |
| `flows/smoke.yaml`         | One example flow: launch with permissions granted, then the settle subflow. Tagged with the first stage of the `qa` suite (`smoke` by default) so `kit qa` runs it |
| `subflows/settle.yaml`     | The settle gate: wait for content (`SETTLED`), then for animation to end                                                                                           |
| `README.md`                | The rules: the settle gate, motion, boolean launch switches, taps that lie, what to gate on, no pixel baselines, device state                                      |
| `.gitignore`               | `output/`, Maestro's run directories                                                                                                                               |

- The flows dir is `maestro.dir` from the config, else `--dir`, else `maestro`. With no `maestro` block the
  command adds `maestro: { dir, version }` to `kit.config.ts` by the same text edit `kit add target` uses.
  A config it cannot edit safely is left alone, nothing is written, the line to paste goes to stdout and the
  exit code is 1; paste it and run the command again.
- App ids: `--ios` / `--android`, else `app.*` in the config, else `release.*`. With none and a terminal it
  asks once and uses the answer for both platforms; without a terminal it exits 2 naming the flags. Two
  different ids make the smoke flow launch the right one per platform (`when: platform:`).
- A file that exists is kept, not an error: a second run prints `nothing to write` (`--json`: `unchanged: true`),
  and a deleted file comes back without touching the others. `--force` overwrites them all. `--dir` cannot be
  the repo root or a hidden directory (`.`, `.github`): exit 2.
- The `.gitignore` entry follows `maestro.output` when it sits under the flows dir; otherwise the README says
  to ignore it. The README also explains that `maestro.version` is pinned on purpose and how to change it.
- Ids and tags are quoted in the YAML when needed (`null`, `yes`, a `:`).
- `flows/smoke.yaml` gates on the placeholder `Replace with text from your first screen`, which is not on
  any screen, so it fails until you pick a string from your fixture. A gate that cannot fail is not a gate.
