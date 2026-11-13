# Installing and updating kit

## Install

```sh
bun add -d @jordond/kit
kit --help
```

Install it globally too (`bun add -g @jordond/kit`) to get `kit` on your `PATH`: the global launcher finds
the nearest `kit.config.ts` and runs that repo's own pinned copy.

Keep the global kit at least as new as the repos it is used in. A launcher only knows the repo layouts
of its own release, so an older global kit can miss a newer repo's copy. kit guards against running
the wrong copy:

- A kit that finds the repo's own copy installed, and is not that copy, runs the repo's copy instead.
- A kit whose version the repo's pin excludes, in a repo whose copy is not installed, stops with exit 4
  and names the install to run. `kit doctor`, `kit upgrade`, `kit init`, `--help` and `-V` still run,
  with a warning.
- `kit doctor` warns when the `kit` on `PATH` is older than the repo's (`bun add -g @jordond/kit@<version>`).

Kits before this guard cannot check themselves: update a global kit older than 0.8 by hand.

## Install dir: the root or `.kit/`

kit is a dev dependency in the root `package.json`, or in `.kit/package.json` for repos that must not have
a root `package.json`:

```sh
mkdir -p .kit && cd .kit && bun init -y && bun add -d @jordond/kit   # then: .kit/node_modules/.bin/kit
```

The config can sit next to it as `.kit/kit.config.ts`, where editors resolve the `@jordond/kit` import
through `.kit/node_modules`; a root `kit.config.ts` wins when both exist and still runs (kit resolves the
import to itself), but editors show it unresolved. Paths in the config are relative to the repo root in
both places. The launcher, `kit init`, `kit doctor`, `kit upgrade`, the setup action and
`mobile-distribute.yml` all look in both places. Kotlin toolchain repos need `.kit/`: the toolchain runs
`pnpm add` for its Kotlin/Wasm test browser in a build folder with no `package.json`, and pnpm installs
into the nearest one above it.

## Keeping kit up to date

A repo pins kit twice: the `@jordond/kit` range in `package.json` (or `.kit/package.json`) and the
`jordond/kit/…@<sha> # vX.Y.Z` refs in `.github/workflows`. Both must name the same release;
`kit doctor --ci` fails when they differ.

By hand:

```sh
kit upgrade            # the latest release on npm
kit upgrade 0.6.0
```

Moves the range, runs the install, and rewrites every workflow ref to that release's tag commit.
Re-running it repairs workflow pins that lag the npm pin (`kit doctor --fix` does that part too).

With Renovate, extend kit's preset (the `kit init` templates write this `renovate.json`):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "github>jordond/kit//renovate/default"]
}
```

The preset puts the npm package and the workflow refs in one group, so a kit release arrives as one
PR; moves the `package.json` range itself (`^0.6.0` to `^0.6.1`), never only the lockfile; and keeps
the workflow refs pinned to a commit SHA with the `# vX.Y.Z` comment kit reads.

## Shell completion

```sh
source <(kit completion zsh)                                  # ~/.zshrc, after compinit
source <(kit completion bash)                                 # ~/.bashrc
kit completion fish > ~/.config/fish/completions/kit.fish
```

The script calls back into the `kit` on your `PATH`, so it follows each repo's pinned version and
works outside a repo too. `kit init` offers to install it for your `$SHELL` when `kit` is on `PATH`, and
never in CI: fish gets its completions file; zsh and bash get the script in `~/.config/kit/` and a line
in `~/.zshrc` (`~/.bash_profile` on macOS, else `~/.bashrc`) that sources it. Sourcing a file means no
kit process runs when a shell starts.
