# Changelog

## 0.15.0 (2026-11-27)

### Features

- **shots:** Play's foldable screenshots. `shots.foldable.slides` lists HTML slides (`{ name, file, shot, aspect, background }`), each drawn at one of Play's foldable aspects (`1:1`, `4:3`, `3:4`, `16:10`, `10:16`, `16:9`, `9:16`) and written by `kit shots export` to `<locale>/images/foldableScreenshots/`, numbered and owned apart from the phone set, whether the phone slides come from `shots.project` or `shots.slides`. The config takes 3 to 8 and wants one each of `1:1`, `4:3` and `10:16`. The Play API has no foldable image type, so `kit release metadata push` warns that they are to be uploaded by hand.
- **maestro:** a suite can name its `device` (an AVD or simulator, booted when not running), and on Android a `posture` (`adb emu fold|unfold` on a foldable emulator) and an `orientation` (turned by the emulator's sensor, which an unfolded foldable obeys where Maestro's `setOrientation` is ignored). The emulator is woken and its keyguard dismissed after a posture change.
- **maestro:** `--suite a,b` runs several suites in order on one build, as `shots.suites` does.

## 0.14.0 (2026-11-27)

### Features

- **shots:** `kit shots export` renders HTML slides. `shots.slides` lists HTML pages (`{ name, file, shot, background }`) that are drawn for every store set and locale in place of the slides of `shots.project`, under the same file names, flags and ownership rules; setting both is a config error. The page is told its set, target, locale and raw shot through `data-kit-*` attributes on `<html>`, `--kit-shot`, `<img data-kit-shot>` and the query string. kit picks each set's device scale factor.
- **shots:** `shots.suites` lists the Maestro suites `kit shots <target>` runs in order on one build, so `kit shots <target>` then `kit shots export` is the whole flow when some screenshots need a second fixture.
- **commands:** a repo command's boolean flag with `default: true` takes `--no-<flag>` without `negatable: true`, and help shows it as `--[no-]<flag>`.

### Fixes

- **shots:** `kit shots pages` no longer renders through a viewport narrower than headless Chrome's 500 CSS px minimum, where the page was laid out wider than asked and cropped without an error. A `shots.pages` entry whose `width / scale` is under 500 is now a config error that names the scale to use, and every render fails when the page reports a viewport other than `width / scale` by `height / scale`. A config that relied on a narrower viewport fails to load until its `scale` is lowered.

## 0.13.1 (2026-11-27)

### Fixes

- **release:** `kit release android` (Kotlin toolchain, `release.android.sentry` set) no longer fails with "wrote no R8 mapping" when R8 is up to date. The mapping is now taken from the build output of the AAB that was built, whatever its mtime, instead of only a `mapping.txt` written during this build. A build with no mapping at all still fails.
