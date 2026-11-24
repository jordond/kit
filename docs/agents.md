# Coding agents

An agent that finds a `kotlin` wrapper or `gradlew` in a repo runs it. kit gives it three reasons not to:
a guide it reads at the start of every session, a command that prints the same guide, and (opt-in) a
Claude Code hook that refuses the direct build and names the kit command. For a repo not on kit yet, it
prints a prompt that has an agent do the migration.

```sh
kit agents sync            # AGENTS.md block + CLAUDE.md import
kit agents sync --hooks    # and the Claude Code hook
kit agents guide           # the block on stdout
kit agents migrate         # a prompt for an agent to move this repo onto kit
kit init --agents          # write the guide during init; --hooks adds the hook too
```

## The guide

`kit agents sync` writes one block into `AGENTS.md`, between `<!-- kit:start -->` and `<!-- kit:end -->`.
kit owns that block and nothing else: text outside the markers is kept, a file without the block gains it
at the end, and a missing file is created. `CLAUDE.md` gets an `@AGENTS.md` import (appended when the file
exists and does not mention `AGENTS.md`), so Claude Code loads the same guide.

The block is generated from `kit.config.ts`: the command table, the targets and their kinds, the
passthrough (`kit kotlin` or `kit gradle`), and for a Kotlin toolchain project the module names from
`project.yaml`. Module and platform rows appear only when the repo has a `gradle` or `kotlin` target. When
kit lives in `.kit/`, it also names `./.kit/node_modules/.bin/kit` for a shell without `kit` on PATH.

The block also tells the agent where new tooling goes: a task worth repeating becomes a repo command
(`.kit/commands/<name>.ts`, see [commands.md](commands.md)) instead of a standalone script. A script file
is for a one-off, deleted once it has run.

All of this is opt-in. A repo without the block gets one dim line from `kit doctor` saying how to add it,
never a warning. Once the block is there, `kit doctor` warns when it differs from what the config
generates now (a new target, a new module, a kit upgrade) and `kit doctor --fix` runs the sync.
`kit init` writes the guide with `--agents` or `--hooks`, asks in a terminal (default no), and keeps an
existing block current; `--yes` alone does not add it.

## The hook

`kit agents sync --hooks` adds a `PreToolUse` hook on `Bash` to `.claude/settings.json`, keeping whatever
else the file holds:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "kit agents hook" }] }]
  }
}
```

With kit in `.kit/` the command is `"$CLAUDE_PROJECT_DIR"/.kit/node_modules/.bin/kit agents hook`. Once
installed, a later `kit agents sync` (or `kit doctor --fix`) keeps the command current without the flag.

`kit agents hook` reads the tool call from stdin and exits 2, with the kit command on stderr, for a direct
build or test:

| The agent runs                              | It is told to run                    |
| ------------------------------------------- | ------------------------------------ |
| `./kotlin build -m core -p jvm`             | `kit build -m core -p jvm`           |
| `./kotlin test --include-classes 'A*'`      | `kit test -- --include-classes 'A*'` |
| `./gradlew build`, `./gradlew :core:test`   | `kit build`, `kit test -m :core`     |
| `./gradlew spotlessCheck` / `spotlessApply` | `kit lint` / `kit format`            |

Everything else passes: `./kotlin run`, any other Gradle task (`:app:installDebug`), a Gradle command that
mixes a kit verb with another task, `kit kotlin build …` and `kit gradle …` (the way to run the wrapper on
purpose), a bare `kotlin` or `gradle` on PATH, and any input the hook cannot read. The Kotlin rule applies
only with `toolchain` in the config, the Gradle one only with `gradle`.

The hook is opt-in because it edits a file Claude Code owns and it only works there; the guide is what
other agents get.

## Migrating a repo

`kit agents migrate` prints a prompt for a coding agent that moves an existing repo onto kit. It runs
without a `kit.config.ts` (with a global kit or `bunx @jordond/kit agents migrate`) and writes nothing:

```sh
claude "$(kit agents migrate)"   # an interactive session: the agent stops for your approval
kit agents migrate > migrate.md
kit agents migrate --json        # { prompt, facts }
```

Hand the prompt to an interactive session, not a pipe: the agent asks before it changes anything.

What the prompt has the agent do:

1. Check that the working tree is clean (otherwise stop and ask), and branch off the default branch.
2. Inventory the repo's tooling: what each script does, who calls it, where it goes.
3. Run the existing lint, typecheck, test and build commands for a baseline.
4. Show the plan (config outline, where each script goes, every file it will touch, open questions) and
   wait for an explicit yes.
5. Install kit and write the config.
6. Give every script a kit home: a kind default or a target's verb field, `workspace`, `deploy.before`,
   the `env`, `release` or device blocks, or a repo command in `.kit/commands/<name>.ts` (see
   [commands.md](commands.md)). `package.json` scripts that a kind default runs, and scripts a build
   tool calls, stay as they are.
7. Point CI (through kit's setup action), git hooks and docs at kit, and delete what kit replaced.
8. Run `kit agents sync`, then verify with `kit doctor --ci`, `check`, `test` and `build` against the
   baseline.
9. Report each old script and what replaced it, with one commit per step on the branch.

Behaviour stays the same, secrets stay out of the config and commits, and nothing deploys, releases or
pushes.

kit adds what it can see three directories down from the git root: `package.json` scripts and git hook
keys, scripts under any `scripts/`, `bin/`, `tools/` or `ci/` directory, task runners (Make, just, Task,
Turborepo, Nx), Gradle and Kotlin toolchain wrappers, Worker, Vite, Astro and Docker configs, Fastfiles,
`.env` templates, CI config (GitHub Actions, GitLab, CircleCI, Jenkins, Bitrise, Azure), git hooks and
tool pins. Past 60 findings it gives a count. kit goes in `.kit/` when `.kit/package.json` exists, or for a
Kotlin toolchain project without a root `package.json`. In a repo that already has a config, the prompt
names its targets and says to extend it; a config that does not load stops this command like any other,
so fix it first (`kit config` lists the problems).
