# kit

One CLI for a repo that ships more than one thing: a Kotlin Multiplatform app, the Cloudflare Workers
behind it, a Vite or Astro site. `kit` gives them the same verbs, on a laptop and in CI, and owns the
parts every app otherwise rebuilds: store releases, env and secrets, devices, UI tests and screenshots.

```sh
kit check --affected        # lint and typecheck what this branch changed
kit test api                # one target
kit qa ios                  # boot a simulator, build, install, run the Maestro flows
kit release ios --track beta
```

It ships as one package, `@jordond/kit`: the CLI, a shared fastlane setup, Gradle convention plugins,
reusable GitHub workflows and a Renovate preset.

## What it does

- **One set of verbs.** `lint`, `format`, `typecheck`, `check`, `test`, `build`, `dev` and `deploy` run
  across every target, with sensible defaults per kind (Gradle, Kotlin toolchain, Cloudflare Worker, Vite,
  Astro, Docker, custom) and per-target overrides. `--affected` and `--staged` run only what changed.
- **Mobile releases.** `kit release ios|android` reads the version, takes the next build number from the
  store, builds, signs, uploads and tags. Promote a build between tracks, change a staged rollout, and
  keep the store listing and screenshots in the repo. One shared Fastfile; no fastlane config per app.
- **Devices and the debug app.** Boot or create a simulator or emulator, then build, install and run
  the debug app on it.
- **UI tests and screenshots.** Run [Maestro](https://maestro.dev) flows against a known app state
  (fixtures), capture raw screenshots, and compose them into store-size images in a browser studio.
- **Env and secrets.** One `.env` checked against a zod schema, rendered into each target's files, and
  pushed to Worker and GitHub secrets. Values never reach output.
- **Cloudflare Workers.** Preview deploys with a pull request comment, rollback, log tailing, and D1
  backup, restore, seed and reset.
- **Repo setup.** `kit init` sets up a fresh clone or scaffolds a new repo, `kit add` scaffolds modules
  and targets, and `kit doctor` checks the tools the config needs and fixes what is safe to fix.
- **Made for scripts.** Commands take `--json` and `--dry-run`, and exit codes are stable.

## Requirements

[Bun](https://bun.sh) 1.3 or newer. Everything else depends on what the repo builds (a JDK, Xcode, the
Android SDK, wrangler, Maestro): `kit doctor` lists what is missing.

## Install

```sh
bun add -d @jordond/kit     # pinned per repo
bun add -g @jordond/kit     # optional: `kit` on your PATH
```

The global `kit` is a launcher: it finds the nearest `kit.config.ts` and runs that repo's own pinned
copy, so laptops and CI agree. Repos that must not have a root `package.json` install into `.kit/`
instead. See [Installing and updating](docs/install.md).

## Quick start

Starting a new repo? `kit init --template gradle` or `--template toolchain` writes the config, CI
workflows and tool pins for you ([Scaffolding](docs/scaffolding.md)). In an existing repo, add a
`kit.config.ts` at the root:

```ts
import { defineConfig } from '@jordond/kit'

export default defineConfig({
  name: 'my-app',
  gradle: { root: 'apps/client' },
  targets: {
    client: { kind: 'gradle', dir: 'apps/client' },
    api: { kind: 'worker', dir: 'apps/api', paths: ['packages/shared'] },
    site: { kind: 'astro', dir: 'apps/site' },
  },
})
```

Then:

```sh
kit doctor                  # are the tools this config needs installed?
kit check                   # lint and typecheck every target
kit test api -- --watch     # arguments after -- go to the tool
kit dev site
kit deploy api --preview
```

Every field, with defaults and full examples, is in the [config reference](docs/CONFIG.md).

## Commands

`kit --help` lists everything; `kit <command> --help` has the flags.

| Group   | Commands                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Develop | `dev`, `build`, `deploy`, `app`, `device`, `fixture`, `open`, `clean`, and the passthroughs `gradle`, `kotlin`, `wrangler`, `maestro`, `xcode` |
| Quality | `lint`, `format`, `typecheck`, `check`, `test`, `qa`, `shots`                                                                                  |
| Release | `release`, `version`, `fastlane`, `changelog`                                                                                                  |
| Infra   | `env`, `db`, `logs`                                                                                                                            |
| Setup   | `doctor`, `init`, `add`, `deps`, `upgrade`, `config`, `completion`                                                                             |

A repo adds its own commands, or wraps a built-in, with a file in `.kit/commands/`
([Repo commands](docs/commands.md)).

## Documentation

| Page                                                 | Covers                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Config reference](docs/CONFIG.md)                   | Every `kit.config.ts` field, validation rules, environment variables, examples                          |
| [Installing and updating](docs/install.md)           | The global launcher, the `.kit/` install dir, `kit upgrade`, Renovate, shell completion                 |
| [Scaffolding](docs/scaffolding.md)                   | `kit init` templates, `kit add module`, `kit add target`, `kit add maestro`                             |
| [Affected targets, timings and clean](docs/verbs.md) | `--affected`, `--staged`, step timings, `kit clean`                                                     |
| [Devices and the debug app](docs/devices.md)         | `kit device`, `kit app`, emulator images and arguments                                                  |
| [Maestro](docs/maestro.md)                           | `kit qa`, `kit shots`, suites, fixtures, the reusable QA workflow                                       |
| [Store screenshots](docs/shots.md)                   | `kit shots export`, `pages`, `studio` and `migrate`                                                     |
| [Releases](docs/releases.md)                         | Versions, `kit release`, promote, rollout, preflight checks, the store listing, the distribute workflow |
| [Env](docs/env.md)                                   | The `.env` schema, `kit env push` and `kit env rotate`                                                  |
| [Cloudflare Workers](docs/cloudflare.md)             | Preview deploys, rollback, logs, D1                                                                     |
| [Kotlin toolchain](docs/kotlin-toolchain.md)         | Apps built with the JetBrains Kotlin Toolchain instead of Gradle                                        |
| [Repo commands](docs/commands.md)                    | Adding commands and wrapping built-ins                                                                  |
| [Doctor](docs/doctor.md)                             | What `kit doctor` checks and what `--fix` repairs                                                       |
| [Changelog](docs/changelog.md)                       | `kit changelog` from Conventional Commits                                                               |

## CI

kit runs the same in CI as locally. For GitHub Actions the repo also provides:

- a [setup action](.github/actions/setup/README.md): Bun, dependencies, and optionally Java, Ruby with
  kit's fastlane bundle, and mise;
- [`mobile-distribute.yml`](docs/releases.md#ci), a reusable workflow that releases, promotes and
  changes rollouts;
- [`mobile-qa.yml`](docs/maestro.md#maestro-in-ci), a reusable workflow that runs `kit qa` on an iOS
  simulator and an Android emulator.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checkout, checks and tests.

## License

[MIT](LICENSE)
