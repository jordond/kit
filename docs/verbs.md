# Affected targets, step timings and clean

## Affected targets

```sh
kit check --affected                        # what this branch changed since origin/<default branch>
kit test --affected --base origin/develop
kit lint api web --affected                 # named targets ∩ affected ones
```

`lint`, `format`, `typecheck`, `check`, `test` and `build` take `--affected [--base <ref>]`: only the
targets changed since the merge base with `<ref>` run, counting commits on the branch plus staged,
unstaged and untracked files. The default base is `origin/<default branch>` (from `origin/HEAD`), then
`origin/main`, then `main`; a base that doesn't exist runs everything, with a warning.

A target is affected by a change under its `dir`, or under one of its `paths` (dirs or globs, for shared
code that lives elsewhere):

```ts
targets: {
  api: { kind: 'worker', dir: 'apps/api', paths: ['packages/shared', 'schema/**/*.sql'] },
}
```

A glob that matches a directory (`packages/*`) claims everything under it, and a `!` entry excludes:
`paths: ['packages/shared', '!**/*.md']`. Exclusions apply after the other entries and never to `dir`;
a file a target claims and then excludes is ignored (it does not count as unclaimed).

When HEAD is the default base itself with a clean tree (a push build of `main`), there is nothing to
compare: every target runs, with a warning, and `--json` adds `reason: "head-is-base"`. Pass
`--base HEAD~1` or the previous release tag there. With an explicit `--base`, no difference means
nothing runs. When `kit.config.ts` sits below the git root, a change outside it counts as unclaimed.

A changed file that no target claims (the root lockfile, `kit.config.ts`, CI workflows) affects every
target, and the workspace commands run whenever anything changed. Nothing changed exits 0. Unlike
`--staged`, tools get no file list: `--affected` only picks targets, and the two can't be combined.
`--staged` picks targets by the same `dir` and `paths` rule, but a staged file no target claims selects
none (the workspace commands still get it), so pre-commit hooks stay fast.
`--json` adds `affected` (the target names) and `base`.

## Step timings

After a verb runs more than one step, the summary lists the five slowest (`--verbose`: all of them).
With `--json`, every step has `ms` and the document a total `ms`; `deploy`, `release` and `init` report
the same fields.

## Clean

```sh
kit clean --dry-run       # list what would go, with sizes
kit clean client          # one target
kit clean --deep --yes
```

`kit clean [targets...]` deletes build output: `.gradle/`, `.kotlin/` and each Gradle project's `build/`
under the Gradle root (never `~/.gradle`), the Kotlin toolchain's `build/`, `dist/`, `.wrangler/tmp`,
`.astro` and the bundler caches in `node_modules` for worker, vite and astro targets, and the
`release.ios.output` .ipa with its dSYM zip (their dir too, only when it holds nothing else and git
tracks nothing in it). `--deep` adds `node_modules` (root and `.kit/`), `.wrangler/state` (your local
D1/KV data) and the configured iOS project's Xcode DerivedData. It lists every path with its size and asks
first (`--yes` skips the question); `--json` reports `{ removed: [{ path, bytes }], bytes }`. Symlinks
and anything that resolves outside the repo root are refused.
