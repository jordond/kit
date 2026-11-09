# kit Gradle conventions

Two artifacts, published by `bun run build:gradle` (`./gradlew publishKit`) into `gradle/maven`, the
file Maven repo inside the npm package (PLAN §13.2):

- `io.github.jordond.kit:kit-settings`: the settings plugin. It never references AGP, KGP or Compose types (spike S7).
- `io.github.jordond.kit:kit-plugins`: every project plugin.

Both POMs carry no dependencies. AGP, KGP, Compose and spotless come from the app's root
`plugins { alias(...) apply false }`, so kit never forces an upgrade.

## Plugin ids

| Id                                         | Apply to                                         | Does                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `io.github.jordond.kit.settings`           | `settings.gradle.kts`                            | `TYPESAFE_PROJECT_ACCESSORS`; the foojay resolver if it is on the settings classpath; Google (filtered to androidx/com.android/com.google) + Maven Central dependency repos                                                                |
| `io.github.jordond.kit.release`            | Android app module and/or the shared KMP module  | App: versionName/versionCode from `-Pkit.*`, release signing, fails an unsigned release build. KMP: generates `BuildConstants` into commonMain                                                                                             |
| `io.github.jordond.kit.lint`               | root `build.gradle.kts`, once                    | spotless + ktlint on every project: kotlin (`src/**/*.kt`), kotlinGradle (`*.gradle.kts`), xml (`src/**/*.xml`); ktlint reads the nearest `.editorconfig` at or above the Gradle root                                                      |
| `io.github.jordond.kit.kmp.library`        | shared KMP modules                               | KMP, default hierarchy, shared opt-ins, `-Xexpect-actual-classes`, `-Xexport-kdoc` on native; targets via `kit { targets { } }`; Android through `com.android.kotlin.multiplatform.library` with namespace `<app-name>.<module>`          |
| `io.github.jordond.kit.compose`            | KMP modules using Compose                        | Compose compiler + Compose Multiplatform plugins; runtime, foundation, ui (+ components-resources) at the Compose plugin's version; Compose opt-ins                                                                                        |
| `io.github.jordond.kit.android.application`| Android app module                               | SDK levels, Java target, packaging excludes, release minify + shrink + default proguard (+ `proguard-rules.pro` if present), Compose build feature when the Compose compiler is applied; namespace/applicationId defaults               |
| `io.github.jordond.kit.android.baseline`   | app module (consumer) / `com.android.test` module (producer) | Consumer: androidx.baselineprofile, `dexLayoutOptimization`, producer dependency, debug signing for `nonMinifiedRelease`/`benchmarkRelease`, `verifyBaselineProfile` + `writeBaselineProfileStamp`. Producer: SDKs, runner, managed device |
| `io.github.jordond.kit.jvm.app`            | JVM server / CLI modules                         | Kotlin JVM with a Java toolchain of `app-jvm-target` (or `kit { jvmTarget }`); optional `application`                                                                                                                                     |

Module build files need no version: the settings snippet's `eachPlugin.useVersion` pins every
`io.github.jordond.kit.*` id to the npm version.

## Required catalog keys (`gradle/libs.versions.toml`, `[versions]`)

Read through `VersionCatalogsExtension.named("libs")`. A missing key fails the build and names the key.

| Key                       | Used by                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `app-android-sdk-compile` | kmp.library (`android()`), android.application, android.baseline producer |
| `app-android-sdk-target`  | android.application, android.baseline producer             |
| `app-android-sdk-min`     | kmp.library (`android()`), android.application, android.baseline producer |
| `app-jvm-target`          | kmp.library (`android()`, `jvm()`), android.application, android.baseline producer, jvm.app |
| `app-android-version`     | release (versionName and BuildInfo when `-Pkit.versionName` is absent) |
| `app-ios-version`         | read by kit's CLI and Xcode, not by Gradle                 |

Optional: `app-name` (default namespace `<app-name>.<module>`, applicationId, BuildInfo package
`<app-name>.core.platform`), `ktlint` (lint), `desugar-jdk-libs` (android.application).

## `kit { }` options

| Option                                                  | Plugin              | Default                                                  |
| ------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| `allowDebugFallback = true`                             | release             | `false`: an unsigned release build fails                 |
| `buildInfo { packageName; className; publicApi }`       | release (KMP)       | `<app-name>.core.platform`, `BuildConstants`, `false` (internal) |
| `targets { android(); ios(); jvm(); js() }`             | kmp.library         | none: declare them                                       |
| `ios { frameworkName = "Shared"; isStatic = true }`     | kmp.library         | module name capitalised, static                          |
| `explicitApi = true`                                    | kmp.library         | `false`                                                  |
| `optIns += "…"`                                         | kmp.library         | kit's shared set                                         |
| `resources = false`                                     | compose             | `true` (adds components-resources)                       |
| `hotReload = true`                                      | compose             | `false`; applies `org.jetbrains.compose.hot-reload`      |
| `applicationId`, `namespace`                            | android.application | namespace = `app-name`; applicationId = namespace        |
| `desugaring = true`                                     | android.application | `false`                                                  |
| `packagingExcludes += "…"`                              | android.application | `/META-INF/{AL2.0,LGPL2.1}` only                          |
| `producer = ":android:baseline"`                        | android.baseline    | none                                                     |
| `baselineContract.from(…)`, `baselineStamp = file(…)`   | android.baseline    | empty; `<producer dir>/baseline-profile.stamp`           |
| `device = "Pixel 6"`, `deviceApi = 34`                  | android.baseline    | Pixel 6, API 34, AOSP image (`pixel6Api34`)              |
| `ktlintVersion`, `excludes += "…"`                      | lint (root)         | catalog `ktlint`, else 1.8.0; none                       |
| `jvmTarget = 25`, `application("pkg.MainKt")`           | jvm.app             | catalog `app-jvm-target`; library                        |

Settings: `kit { extraRepos { ivy(…) { … } } }` appends to `dependencyResolutionManagement`.

## The `release` contract (PLAN §13.4)

- `versionName` = `-Pkit.versionName` ?: catalog `app-android-version`. `versionCode` = `-Pkit.versionCode` ?: `1`.
  The values set in `android { defaultConfig { } }` are overridden.
- Signing: `-Pkit.keystoreFile=<path>`, or `ANDROID_KEYSTORE_BASE64`, plus `ANDROID_KEYSTORE_ALIAS` and
  `ANDROID_KEYSTORE_PASSWORD` (the key password is the store password). The `kitReleaseSigning` task
  decodes the base64 into `build/kit/signing/release.jks` (0600) right before the release variant's
  packaging and signing tasks. Nothing is written under `.gradle/`.
  - On AGP 9.4+ the signing config is handed to AGP lazily (`SigningConfig.from(Provider)`), so no secret
    is read at configuration time. AGP 9.2/9.3 have no lazy signing API: there the alias, password and
    path are read when the DSL is finalized (a configuration-cache input). The decode still runs in the task.
  - A signing config the module sets on the `release` build type itself is left alone.
- Without signing, a release build fails with
  `kit.release: no signing config; set ANDROID_KEYSTORE_* or pass -Pkit.keystoreFile`, unless
  `kit { allowDebugFallback = true }`. Debug builds, lint and unit tests never need signing.
- BuildInfo (`kitGenerateBuildInfo`, in commonMain):
  - `VERSION_NAME` = Xcode `MARKETING_VERSION` ?: `-Pkit.versionName` ?: `app-android-version`
  - `VERSION_CODE` = Xcode `CURRENT_PROJECT_VERSION` ?: `-Pkit.versionCode` ?: `1`
  - `IS_INTERNAL` = `-Pkit.internal` ?: env `KIT_INTERNAL` (`true`/`1`) ?: `false`
  - `GIT_SHA` = `git rev-parse --short HEAD` ?: `unknown`
  - No `-dev` suffix.

## Tests

```sh
cd gradle
./gradlew kitMatrix                     # min and max
./gradlew kitMatrix -Pkit.matrix=max    # one cell
```

`kitMatrix` publishes both artifacts to `build/kit-test-repo` and runs TestKit fixtures that resolve
kit the way apps do, with the configuration cache on. The fixtures are a KMP library and an Android app, plus a
baseline producer and JVM app at max. Cells: min = AGP 9.2.1, Kotlin 2.4.0, Compose 1.11.1, Gradle 9.6.1;
max = AGP 9.4.1, Kotlin 2.4.21, Compose 1.12.2, kit's Gradle. Fixtures stay in `plugins/build/kit-fixtures`.

## Dev loop

`KIT_GRADLE_DEV=~/dev/kit/gradle` makes an app's settings `includeBuild` this directory instead of the
published jars (§13.2 snippet).
