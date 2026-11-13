# Devices and the debug app

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

|                  | Android                                          | iOS simulator                                                        |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Gradle           | `<module>:assembleDebug`                         | `xcodebuild -scheme <scheme> -configuration Debug` for the simulator |
| Kotlin toolchain | `./kotlin build -m <module> -p android -v debug` | `./kotlin build -m <module> -p iosSimulatorArm64 -v debug`           |

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
