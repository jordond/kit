# kit setup action

Composite action for repos that use kit. Sets up Bun, installs dependencies, and optionally Java + Gradle, Ruby with kit's fastlane bundle, and mise.

```yaml
- uses: actions/checkout@v7
- uses: jordond/kit/.github/actions/setup@v0.1.0 # match the @jordond/kit version in bun.lock
  with:
    java: true # Temurin 21 + gradle/actions/setup-gradle
    ruby: true # Ruby 3.4 + kit's fastlane bundle
- run: kit check
```

Dependencies install from the root `package.json`, and from `.kit/package.json` when the repo keeps kit there
(Kotlin toolchain apps). Either way `kit` is on `PATH` for later steps.

| Input         | Default | Effect                                                                                           |
| ------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `bun-version` | `''`    | Empty: `packageManager` (`bun@x`) or `devEngines.packageManager` in package.json, else `1.3.14`. |
| `java`        | `false` | `true` = Temurin 21, or a version (`'17'`). Also runs `gradle/actions/setup-gradle`.             |
| `ruby`        | `false` | `true` = Ruby 3.4, or a version. Needs `install: true`.                                          |
| `mise`        | `false` | `true` runs `jdx/mise-action` (tools from `mise.toml`).                                          |
| `install`     | `true`  | `bun install --frozen-lockfile`.                                                                 |

With `ruby`, the action exports `BUNDLE_GEMFILE=node_modules/@jordond/kit/fastlane/Gemfile`, `BUNDLE_PATH=$RUNNER_TEMP/kit-bundle` and `BUNDLE_FROZEN=true`, restores the bundle from a cache keyed on kit's `Gemfile.lock`, and runs `bundle install`. Gems never land in `node_modules`; a kit bump that changes the lockfile gets a fresh cache.

Pin the action to the same tag as the kit version the repo installs, so the action and the package agree.
