# Maestro flows

Black-box UI flows for the app, run by `kit qa` on a simulator or an emulator. kit
builds and installs the app, loads the fixture, boots a device when none is running,
and runs the flows. Maestro drives the accessibility tree, so it works on a release
build with no instrumentation.

```sh
kit qa ios
kit qa android --junit report.xml
kit lint maestro          # maestro check-syntax over every flow
```

## Layout

```
config.yaml           stops `maestro test` from running subflows as flows
flows/                one file per run, each tagged
subflows/             reusable pieces; not runnable on their own
{{outputLine}}```

{{outputNote}}
A flow is selected by its tags. `kit qa` runs the suite named `qa` in `kit.config.ts`
(default: tag `smoke`). A flow nobody runs rots quietly, so give every flow a tag that
some suite runs.

Anything that wipes app state (`clearState`, onboarding) belongs in a last stage of
its own: `stages: [['smoke'], ['onboarding']]`. Do not rely on `executionOrder` in
`config.yaml`: under `--include-tags` a filtered-out first entry errors and a
filtered-out middle entry silently drops the ordering. kit runs each stage as its own
Maestro invocation instead.

## The Maestro version is pinned

`maestro.version` in `kit.config.ts` ({{version}} when this was scaffolded) is pinned on
purpose. `kit doctor` compares it with the installed CLI and the `mobile-qa` workflow installs
exactly it, so a flow that passes today passes on CI next month. To move to a newer Maestro,
change that one line, then run `kit lint maestro` and `kit qa` on both platforms before merging.

## The settle gate

A UI toolkit can publish an element to the accessibility tree before it has painted
it. `assertVisible` then returns while the screen is still blank, a screenshot catches
an empty frame, and every step reports COMPLETED. `waitForAnimationToEnd` cannot
rescue it alone: a blank screen is a still one, so it returns at once.

`subflows/settle.yaml` is the fix. Every flow reaches a screen through it:

1. Wait for a piece of content, not chrome. A header paints before the list under it,
   so text that comes from the fixture can only appear once the data is on screen.
2. `waitForAnimationToEnd`, now that there is something to animate.

Adding a screen means a subflow that taps to it and calls `settle.yaml` with a
`SETTLED` string. Pick that string out of the fixture, not out of a config plane an
operator can edit without a deploy. Then check the gate: point it at a string that is
not there. The flow must fail.

Two traps when passing `SETTLED` around:

- A subflow's own header `env:` overrides what its caller passes. Give `settle.yaml` a
  default `SETTLED` and every caller's gate silently becomes that default.
- `text` and `visible` match the whole string, as a case-insensitive regex. A partial
  does not match. Use the whole on-screen string or anchor it (`"September.*"`).

## Motion

Maestro decides a screen has settled by comparing consecutive frames, so one looping
animation anywhere on it means the screen is never still. Nothing fails: every
`waitForAnimationToEnd` just burns its whole timeout, and every screenshot races a
frame that has already moved on.

Looping animations must be frozen under automation. That is app code: read a launch
switch (below) and hold every endless loop on a chosen frame, so the screen goes still
without going blank. kit cannot do this for you. Animations that end on their own (a
press bounce, a sheet sliding up) settle without help.

## Launch switches

`launchApp: arguments:` tells the app something before it draws. Write switches as
booleans. Maestro passes a boolean to iOS as a bare `key value` process argument and a
string or number as `-key value`, so on iOS only the dashed form reaches
`NSUserDefaults`, and an app that tests whether the key is present misses it. Android
reads the same key as an intent extra either way.

```yaml
- launchApp:
    stopApp: true
    permissions:
      all: allow
    arguments:
      IS_AUTOMATION: true
```

Grant permissions on every launch (`permissions: all: allow`) rather than trusting
whatever state the device was left in. A permission dialog landing on a screenshot is a
flake that only reproduces on a device nobody has used yet.

## Taps that lie

`tapOn` waits for an element to exist. It does not go looking for one and does not
check that what it found is on screen: a tap at the coordinates of something scrolled
out of the viewport reports COMPLETED and does nothing. The flow then fails a step
later, on the gate for a screen that never opened.

So anything below the fold gets `scrollUntilVisible` first, then
`waitForAnimationToEnd` before the tap: a list is still gliding when the scroll returns,
and a tap into a moving list lands on whatever has slid under the finger.

A flow that changes state another flow reads (adds a row, picks a card up) can break
that other flow as easily as its own. Leave the fixture as you found it.

## What to gate on

In descending order of how long it keeps working:

1. Fixture content. It is committed, and changing it is a diff someone reviews.
2. An accessibility identifier (`id`), for anything with no text of its own.
3. Chrome (a tab label, a button). Fine as a tap target, weak as a gate: it is on
   screen before the content is.
4. A config plane, such as a title an operator edits remotely. The flow breaks with no
   deploy and no review.
5. Generated data, such as a name out of a seed script. Re-seeding retires it.
   Prefer a position: the first row under a heading.

## No pixel baselines

Assert text, never pixels. A committed PNG per platform breaks every time the frame
moves for a reason no fixture controls: the device model, a remote flag adding a
button, the device's calendar month passing the date the fixture was pinned to. A
visual check that holds still wants a JVM screenshot test of the stateless
composable or view with preview data, not a device.

## What the device state has to be

- Emulators kit creates use a Google Play image. Play images refuse `adb root`, so
  fixtures reach app storage through `run-as`, which needs a debuggable build. `kit app
  install android` installs one.
- iOS physical devices are not driven by Maestro. Use a simulator.
- Maestro needs Java 17 or newer. `kit doctor` checks it and the version pinned in
  `maestro.version`.
- Always run through `kit qa` or `kit maestro`: they pass `--device`. Without it
  Maestro waits on a stdin picker when zero or several devices match.
