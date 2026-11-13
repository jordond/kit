# Kotlin toolchain

Apps built with the [JetBrains Kotlin Toolchain](https://kotlin-toolchain.org/latest/) (formerly Amper)
have a `kotlin` wrapper, `project.yaml` and one `module.yaml` per module instead of Gradle.
[`kit init --template toolchain`](scaffolding.md#new-repos) sets all of this up. By hand: install kit in
[`.kit/`](install.md#install-dir-the-root-or-kit), set `toolchain.root` in place of `gradle` (they are exclusive)
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
    ios: {
      bundleIds: ['app.bekindrewind'],
      project: 'iosApp/module.xcodeproj',
      scheme: 'app',
      output: 'App.ipa',
    },
  },
})
```

|                           | Gradle                            | Kotlin toolchain                                                                   |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| `kit test` / `kit build`  | `./gradlew test` / `build`        | `./kotlin test` / `build`                                                          |
| `kit lint` / `kit format` | `spotlessCheck` / `spotlessApply` | `ktlint` / `ktlint -F` over `**/*.kt` and `**/*.kts`, skipping `build/`            |
| `kit build <t> --release` | `<project path>:bundleRelease`    | `./kotlin package -m <module name>` (AAB only)                                     |
| passthrough               | `kit gradle …`                    | `kit kotlin …`                                                                     |
| `kit init`                | `gradle.init` tasks               | `toolchain.init` (default `./kotlin --version`, which downloads the toolchain)     |
| `kit doctor`              | java, Android SDK, catalog keys   | the wrapper and its pinned `kotlin_cli_version`, and ktlint; no java or SDK needed |

The toolchain has no linter, so `kotlin` targets use the standalone `ktlint` binary: pin it in `mise.toml`
(`ktlint = "1.8.0"`) and style it with `.editorconfig`. `kit lint --staged --fix` passes only the staged
Kotlin files. Override with `lint:` / `format:` on the target, or `false` to turn one off.

`release.android.module` is the app module's directory relative to `toolchain.root`: `androidApp`, or
`mobile/android` when the modules live under another directory, at any depth. The toolchain names a module
after its directory's basename, so kit reads `mobile/android/module.yaml` and passes `-m android`; it looks
for build output under `build/tasks/_android_*`. `app.ios.module` works the same way and defaults to the
directory holding the Xcode project. See [Modules](CONFIG.md#modules) for stating the name yourself.

`kit release android` runs `./kotlin package -m <module name>`. The toolchain takes no build
properties, so kit writes `versionName`, `versionCode` and `signing` (a `keystore.properties` in kit's
0600 temp dir, built from the `ANDROID_KEYSTORE_*` secrets) into the module's `module.yaml` for the build and
restores the file afterwards, also on failure or Ctrl-C. `release.android.gates` tasks are `./kotlin`
arguments (`test -m shared`). `kit version bump` also rewrites `settings.android.versionName` in the app's
`module.yaml`, and releases and `kit doctor` fail if it differs from the TOML. There is no `BuildConstants.IS_INTERNAL`:
it comes from kit's Gradle plugin.

`kit release ios` is the same as for Gradle apps: the Xcode project's "Build Kotlin" phase runs the toolchain.
Give the Release configuration manual signing with the match profiles, a `DEVELOPMENT_TEAM`, and
`MARKETING_VERSION` in `release.ios.xcconfig`.
