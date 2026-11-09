# kit

One dev toolkit for every app: the `kit` CLI, a shared fastlane setup, and Gradle conventions, shipped
together as `@jordond/kit`.

```sh
bun add -d @jordond/kit
kit --help
```

## Shell completion

```sh
source <(kit completion zsh)                                  # ~/.zshrc, after compinit
source <(kit completion bash)                                 # ~/.bashrc
kit completion fish > ~/.config/fish/completions/kit.fish
```

The script calls back into the `kit` on your `PATH`, so it follows each repo's pinned version and
works outside a repo too.

## Repo commands

`.kit/commands/<path>.ts` adds `kit <path>`; the file path is the command path. Keep heavy imports
inside `run` so help stays fast.

### Wrapping a built-in

Set `override: true` to replace a built-in with the same path. The override can still run the
built-in through `ctx.builtin(path, options)`, so it only adds what the repo needs.

`ctx.builtin` options (each defaults to the caller's own):

| Option        | Effect                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `mute`        | Regex; matching child-output lines never reach the tree, failure output or `--json` |
| `args`        | Flag values the built-in sees                                           |
| `positionals` | Targets the built-in sees (`kit test api` → `['api']`)                  |
| `rest`        | Arguments after `--`                                                    |

Example: brewd's iOS test link pulls in RevenueCat's prebuilt static libraries (`purchases-kmp`), which
were built with `-gmodules` on RevenueCat's CI. ld warns about each one's missing module cache, about
74 times per run, and has no switch to silence just those. Muting them on RevenueCat's build path
keeps every other linker warning:

```ts
// .kit/commands/test.ts
import { defineCommand } from '@jordond/kit'

/** ld: "… /Users/distiller/project/kn-core/… was built with -gmodules …" from purchases-kmp's static libs. */
const REVENUECAT_MODULE_CACHE_NOISE = /\/Users\/distiller\/project\/kn-(core|ui)\/|built with -gmodules/

export default defineCommand({
  description: 'Run the test suites',
  override: true,
  async run(ctx) {
    await ctx.builtin('test', { mute: REVENUECAT_MODULE_CACHE_NOISE })
  },
})
```

`kit test`, `kit test client` and `kit test --json` all keep working; only the noise is gone.
