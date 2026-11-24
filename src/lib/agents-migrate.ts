import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { configFile, installDir } from '../config/load'
import type { KitConfig } from '../config/schema'

/**
 * `kit agents migrate`: a prompt that walks a coding agent through moving an existing repo onto kit.
 * kit only looks (`migrateFacts`) and writes the prompt (`migratePrompt`); the agent does the work.
 * The scan is shallow and cheap: it names the files the agent should read first, it does not
 * understand them.
 */

/** One existing piece of tooling the agent has to account for. */
export interface Found {
  path: string
  what: string
}

export interface MigrateFacts {
  /** The kit config already there (a migration that was started), repo-relative. */
  configPath?: string
  /** Its targets as `name (kind)`, when it loaded. */
  targets?: string[]
  /**
   * Where kit is or goes: `.kit` when `.kit/package.json` exists, or for a Kotlin toolchain project
   * (a dir holding a `kotlin` wrapper and project.yaml) without a root package.json.
   */
  kitDir: '.' | '.kit'
  /** `@jordond/kit` is already a dependency in `<kitDir>/package.json`. */
  installed: boolean
  found: Found[]
  /** Findings past the cap, left out of `found`. */
  more: number
}

/** The repo to scan when there is no kit config: the git root above `from`, else `from`. */
export function migrateRoot(from: string): string {
  let dir = from
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return from
    dir = parent
  }
}

const SKIP_DIRS = new Set([
  'node_modules',
  'build',
  'dist',
  '.git',
  '.gradle',
  '.kotlin',
  '.idea',
  'Pods',
  '.kit',
])

/** Files under `root` up to `depth` levels down, repo-relative. Skips build output, deps and symlinks. */
function walk(root: string, depth: number, dir = ''): string[] {
  let entries: string[]
  try {
    entries = readdirSync(join(root, dir))
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries.sort()) {
    const rel = dir ? `${dir}/${name}` : name
    let stat
    try {
      stat = lstatSync(join(root, rel))
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isFile()) out.push(rel)
    else if (stat.isDirectory() && depth > 0 && !SKIP_DIRS.has(name)) out.push(...walk(root, depth - 1, rel))
  }
  return out
}

const FILE_RULES: [RegExp, string][] = [
  [/(^|\/)gradlew$/, 'Gradle wrapper'],
  [/(^|\/)kotlin$/, 'Kotlin toolchain wrapper'],
  [/(^|\/)project\.yaml$/, 'Kotlin toolchain project'],
  [/(^|\/)(Makefile|justfile|Justfile|Taskfile\.ya?ml)$/, 'task runner'],
  [/^(turbo|nx)\.json$/, 'monorepo task runner'],
  [/(^|\/)wrangler\.(toml|jsonc?)$/, 'Cloudflare Worker'],
  [/(^|\/)(vite|astro)\.config\.(ts|js|mjs|mts)$/, 'web app'],
  [/(^|\/)Dockerfile$/, 'Docker image'],
  [/(^|\/)(fastlane\/Fastfile|Fastfile)$/, 'fastlane lanes'],
  [/(^|\/)\.env\.(example|sample|template)$/, 'env template'],
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, 'CI workflow'],
  [
    /^(Jenkinsfile|\.gitlab-ci\.yml|\.circleci\/config\.yml|bitrise\.yml|azure-pipelines\.yml)$/,
    'CI pipeline',
  ],
  [/^(lefthook\.ya?ml|\.lefthook\.ya?ml|\.pre-commit-config\.yaml|\.lintstagedrc(\.\w+)?)$/, 'git hooks'],
  [/^\.husky\/[^_/][^/]*$/, 'git hook (husky)'],
  [/^(mise\.toml|\.mise\.toml|\.tool-versions)$/, 'tool versions'],
  [/(^|\/)\.maestro\/[^/]+\.ya?ml$/, 'Maestro flow'],
]

const SCRIPT_DIR = /(^|\/)(scripts?|bin|tools|ci)\//
const SCRIPT_EXT = /\.(sh|bash|zsh|ts|mts|js|mjs|cjs|py|rb|kts|pl)$/
/** Findings listed in full; the rest are counted. */
const CAP = 60

/** Whether a file without an extension starts with a shebang. */
function hasShebang(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(2)
    return readSync(fd, buf, 0, 2, 0) === 2 && buf.toString() === '#!'
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function packageJson(path: string): Record<string, unknown> | undefined {
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    return json && typeof json === 'object' && !Array.isArray(json) ? json : undefined
  } catch {
    return undefined
  }
}

/** What a migration has to look at in the repo at `root`. */
export function migrateFacts(root: string, config?: KitConfig): MigrateFacts {
  const files = walk(root, 3)
  const found: Found[] = []
  for (const f of files) {
    const name = basename(f)
    if (name === 'package.json') {
      const pkg = packageJson(join(root, f))
      const scripts = Object.keys((pkg?.scripts as Record<string, unknown> | undefined) ?? {})
      const hooks = ['husky', 'lint-staged', 'simple-git-hooks'].filter((k) => pkg?.[k] !== undefined)
      const parts = [
        ...(scripts.length ? [`scripts: ${scripts.join(', ')}`] : []),
        ...(hooks.length ? [`git hooks config: ${hooks.join(', ')}`] : []),
      ]
      if (parts.length) found.push({ path: f, what: parts.join('; ') })
      continue
    }
    const rule = FILE_RULES.find(([re]) => re.test(f))
    if (rule) found.push({ path: f, what: rule[1] })
    else if (
      SCRIPT_DIR.test(f) &&
      (SCRIPT_EXT.test(name) || (!name.includes('.') && hasShebang(join(root, f))))
    ) {
      found.push({ path: f, what: 'script' })
    }
  }
  const dirs = (file: string) => new Set(files.filter((f) => basename(f) === file).map((f) => dirname(f)))
  const wrappers = dirs('kotlin')
  const toolchain = [...dirs('project.yaml')].some((d) => wrappers.has(d))
  const kitDir: '.' | '.kit' =
    installDir(root) === '.kit' || (toolchain && !existsSync(join(root, 'package.json'))) ? '.kit' : '.'
  const pkg = packageJson(join(root, kitDir, 'package.json'))
  const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) }
  return {
    configPath: configFile(root),
    targets: config ? Object.entries(config.targets).map(([n, t]) => `${n} (${t.kind})`) : undefined,
    kitDir,
    installed: '@jordond/kit' in deps,
    // Shallow first: the root's package.json and scripts matter more than the 60th app's.
    found: found
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
      .slice(0, CAP),
    more: Math.max(0, found.length - CAP),
  }
}

/** The prompt for the agent doing the migration. `version` is the running kit's, for doc links and pins. */
export function migratePrompt(facts: MigrateFacts, version: string): string {
  const DOCS = `https://github.com/jordond/kit/blob/v${version}/docs`
  const kit = facts.kitDir === '.kit' ? './.kit/node_modules/.bin/kit' : './node_modules/.bin/kit'
  const configAt = facts.configPath ?? (facts.kitDir === '.kit' ? '.kit/kit.config.ts' : 'kit.config.ts')

  const install = facts.installed
    ? [
        `kit is already a dependency in \`${facts.kitDir === '.kit' ? '.kit/' : ''}package.json\`. Run the install if \`node_modules\` is missing, then \`${kit} --version\`.`,
      ]
    : facts.kitDir === '.kit'
      ? [
          'kit goes in `.kit/`: this repo has a `.kit/package.json` already, or is a Kotlin toolchain project with no root `package.json` (the toolchain needs that; see the install docs).',
          '',
          '```sh',
          `[ -f .kit/package.json ] || { mkdir -p .kit && echo '{ "private": true }' > .kit/package.json; }`,
          '(cd .kit && bun add -d @jordond/kit)',
          '```',
          '',
          `Add \`node_modules/\` to \`.gitignore\` if it is not there. The config is \`.kit/kit.config.ts\`. Then run \`${kit} --version\`.`,
        ]
      : [
          `Add kit as a dev dependency at the root with the package manager the repo already uses (\`bun add -d @jordond/kit\`, \`pnpm add -D @jordond/kit\`, …). kit runs on Bun 1.3 or newer whichever manager installs it. The config is \`kit.config.ts\` at the root. Then run \`${kit} --version\`.`,
        ]

  const state = facts.configPath
    ? `A kit config already exists at \`${facts.configPath}\`${
        facts.targets?.length ? ` with targets ${facts.targets.map((t) => `\`${t}\``).join(', ')}` : ''
      }. Treat the migration as started: extend that config, do not start over, and find out from \`git log\` what was already moved.`
    : 'There is no kit config yet.'

  const inventory = facts.found.length
    ? [
        'kit found these (three directories down, build output, dependencies and symlinks skipped). Read each one; the list is where to start, not the whole inventory:',
        '',
        ...facts.found.map((f) => `- \`${f.path}\`: ${f.what}`),
        ...(facts.more ? [`- …and ${facts.more} more; list them yourself.`] : []),
      ]
    : [
        'kit found no scripts, task runners or CI config in the top three directories. Look deeper before concluding there is nothing to move.',
      ]

  const lines = [
    '# Migrate this repo to kit',
    '',
    `You are moving this repository's build, test, lint, run, deploy and release tooling onto [kit](https://github.com/jordond/kit) ${version}, a CLI that gives every target in a repo the same verbs (\`kit lint\`, \`format\`, \`typecheck\`, \`check\`, \`test\`, \`build\`, \`dev\`, \`deploy\`) and owns releases, env and secrets, devices, UI tests and screenshots. When you finish, every task a developer or CI runs here goes through \`kit\`, and nothing does the same job twice.`,
    '',
    state,
    '',
    `Run kit as \`${kit}\` once it is installed (plain \`kit\` works too when a global kit is on PATH). The docs linked below are for this release; when you cannot fetch them, \`${kit} --help\` and \`${kit} <command> --help\` are the reference.`,
    '',
    '## Rules',
    '',
    '- Behaviour stays the same. Every command that works today does the same thing after the migration, with the same flags and env, in CI too. When kit cannot do something a script does, keep it as a repo command (step 5); never drop it silently.',
    '- Nothing changes until the user approves your plan (step 3). Before that you read, run the existing read-only commands for a baseline, and create the migration branch; nothing else.',
    "- Work on the migration branch, never the default branch. Commit each step on its own, in the repo's commit message style (read `git log`). Stage the files you changed by name, not `git add -A`, and read `git diff --cached` before each commit. Do not push, open a pull request or rewrite history unless the user asks.",
    '- Config is values only. `kit.config.ts` holds strings, lists and booleans; logic goes in a repo command (`.kit/commands/<name>.ts`) or a `release.preflight` module. An unknown key is dropped with a warning, so look a field up before writing it.',
    "- kit's iOS release has built-in preflights for xcconfig keys overridden by the pbxproj (`--skip xcconfig`) and a stale SwiftPM linkage package (`--skip swiftpm-linkage`). If the repo has equivalent scripts or checks, do not port them as `release.preflight` modules.",
    '- A repeatable task is a kit command, not a standalone script. Every custom script you keep becomes a repo command. A script file is fine only for a one-off, deleted once it has run.',
    "- Prefer kit's built-ins and kind defaults over custom commands: a target whose kind already runs the right thing needs no override.",
    '- Secrets stay secret. A token, key or password written into an old script or workflow moves to `.env` (with its name in `.env.example` and the `env` block) or to the CI secret store; it never goes into the config, a repo command or a commit. Files kit renders from `.env` (`.dev.vars`, `.env.local`) are gitignored.',
    '- Ask before anything you cannot undo or that reaches outside the repo: deleting or renaming CI secrets, changing store listings, deploying, releasing. A migration never deploys or releases.',
    '- When the plan turns out wrong partway (a script does more than you thought, kit lacks a feature), stop and tell the user what changed instead of improvising.',
    '',
    '## 0. Start clean',
    '',
    '- Run `git status`. If the working tree has changes (staged, unstaged, or untracked files that are not ignored), stop: tell the user and ask them to commit or stash them. Do not stash, commit or discard their work yourself.',
    '- If the current branch is the default branch (`main`, `master`, or what `origin/HEAD` points at), create a branch for the migration: `git switch -c kit-migration`, or a name the user gives. On any other branch, ask whether to branch off it or work there. The branch is the only change you make before approval.',
    '',
    '## 1. Inventory',
    '',
    ...inventory,
    '',
    'For each piece of tooling (package.json script, Makefile or justfile recipe, shell script, Gradle task wired into CI, fastlane lane, CI step, git hook), write down what it does, who calls it (developers, CI, git hooks, other scripts, build tools, docs) and which row of the table in step 5 it lands in. Note scripts that a build tool calls: a Gradle `Exec` task, an Xcode run-script phase, a Dockerfile `RUN`, wrangler `build.command`, npm `pre*`/`post*`/`prepare` lifecycle scripts. Keep this table; it becomes your plan and your report.',
    '',
    '## 2. Baseline',
    '',
    'Run the existing lint, typecheck, test and build commands the way CI runs them, and note which pass, which fail and the tool versions (`java -version`, `node -v`, …). Do not run anything that deploys, releases, uploads, or writes outside the repo and its build output. A command that fails now is not yours to fix; it only has to fail the same way after the migration. Afterwards run `git status`: tell the user about any file the baseline changed (a lockfile, generated code, snapshots) and never commit those changes as part of the migration.',
    '',
    '## 3. Show the plan and wait for approval',
    '',
    'Before changing anything, show the user an overview and ask for permission to go ahead:',
    '',
    '- The branch you are on, and that the tree was clean.',
    '- The baseline: what passes and what already fails.',
    `- Where kit will be installed, and the outline of \`${configAt}\`: \`name\`, \`gradle\` or \`toolchain\`, each target with its kind and dir, \`workspace\`, and which other blocks you will add.`,
    '- The inventory table: each script or step, where it goes (kind default, config field, kit verb, repo command `kit <name>`, kept as is, or deleted) and why.',
    '- Every file you will create, change or delete, CI workflows and git hooks included.',
    '- What you will not migrate, and what the user will have to do themselves (CI secrets, credentials, tools to install).',
    '- Open questions: anything you are unsure a script does, or where two homes fit.',
    '',
    'Then stop and wait. Proceed only on an explicit yes. If the user changes the plan, show the changed parts again. Follow the approved plan, and check back before going beyond it.',
    '',
    '## 4. Install kit and write the config',
    '',
    ...install,
    '',
    `Write the config from the [config reference](${DOCS}/CONFIG.md). Its shape:`,
    '',
    '```ts',
    "import { defineConfig } from '@jordond/kit'",
    '',
    'export default defineConfig({',
    "  name: 'my-app',",
    "  gradle: { root: 'apps/client' }, // or toolchain: { root: '.' }; never both",
    '  targets: {',
    "    client: { kind: 'gradle', dir: 'apps/client' },",
    "    api: { kind: 'worker', dir: 'apps/api', paths: ['packages/shared'], typecheck: 'tsc --noEmit' },",
    "    tools: { kind: 'custom', dir: 'tools', test: 'bun test' },",
    '  },',
    "  workspace: { prepare: 'bun run codegen', lint: 'biome check', format: 'biome check --write' },",
    '})',
    '```',
    '',
    '- One target per thing that is built, tested or deployed on its own. Kinds: `gradle`, `kotlin`, `worker`, `vite`, `astro`, `docker`, and `custom` for anything else. `paths` lists shared code outside `dir` so `--affected` stays right.',
    '- A verb field is a shell command run in `dir`, a list run in order, or `false` to turn the kind default off. On a `gradle` target a task name (`spotlessCheck`, `:core:test`) runs through `./gradlew`.',
    '- `versions`, `env`, `cloudflare`, `app`, `devices`, `maestro`, `fixtures`, `shots` and `release` only where the repo already does that job.',
    '',
    `Check it with \`${kit} config\` (prints the parsed config; exits 3 listing each problem) and \`${kit} doctor\`.`,
    '',
    '## 5. Move each script to its kit home',
    '',
    '| The script… | Becomes |',
    '| --- | --- |',
    '| is a `package.json` script a kind default runs (`build`, `dev`, `test`, `deploy` on `vite`, `astro`, `worker`) | stays where it is, with the real command: kit runs it, and a missing script skips the verb. Never make it call kit (`"build": "kit build"` loops) |',
    '| is called by a build tool (Gradle `Exec`, Xcode run-script phase, Dockerfile, wrangler `build.command`, npm lifecycle) | stays as it is; kit never sits inside a build |',
    "| lints, formats, typechecks, tests, builds, runs or deploys one target | nothing, when the kind's default already does it; else that verb's field on the target |",
    '| does the same across the whole repo | the verb in `workspace` |',
    '| generates code the other steps need | `workspace.prepare` |',
    `| generates code that is committed, or a CI step that regenerates it and fails on \`git diff\` | \`codegen: { run, outputs }\`, then \`kit codegen\` and \`kit codegen --check\`; \`kit check\` runs the drift check in CI. Delete the repo \`codegen\` command and the workflow's diff step ([config](${DOCS}/CONFIG.md)) |`,
    "| must run before a deploy (env sync, migrations) | `deploy: { before: ['env sync'] }` on the target |",
    `| renders \`.env\` into files or pushes secrets | the \`env\` block, then \`kit env\` ([env](${DOCS}/env.md)) |`,
    `| applies, seeds or backs up D1 | \`cloudflare.d1\`, then \`kit db\` ([cloudflare](${DOCS}/cloudflare.md)) |`,
    `| bumps versions, builds, signs or uploads to a store (fastlane lanes) | \`versions\` and \`release\`, then \`kit version\`, \`kit release\` ([releases](${DOCS}/releases.md)) |`,
    `| boots a simulator or emulator, installs the app, runs Maestro, takes screenshots | \`app\`, \`devices\`, \`maestro\`, \`fixtures\`, \`shots\` ([devices](${DOCS}/devices.md), [maestro](${DOCS}/maestro.md), [shots](${DOCS}/shots.md)) |`,
    '| runs a Gradle task or `./kotlin` command kit has no verb for | nothing: `kit gradle <task>` and `kit kotlin <args>` pass through |',
    '| changes what a built-in does (silences noise, adds a step before or after) | a repo command with `override: true` that calls `ctx.builtin(...)` |',
    '| anything else worth running again | a repo command: `.kit/commands/<name>.ts` |',
    '| was a one-off that already ran | deleted |',
    '',
    '### Repo commands',
    '',
    `\`.kit/commands/<path>.ts\` adds \`kit <path>\` (\`.kit/commands/icons/sync.ts\` is \`kit icons sync\`). Files and directories starting with \`_\` are helpers, not commands. They live in \`.kit/commands/\` at the repo root wherever kit is installed. See [repo commands](${DOCS}/commands.md).`,
    '',
    '```ts',
    '// .kit/commands/icons.ts: `kit icons`, was scripts/gen-icons.sh',
    "import { defineCommand, runOrThrow } from '@jordond/kit'",
    '',
    'export default defineCommand({',
    "  description: 'Regenerate the app icons from design/icon.svg',",
    "  group: 'Develop',",
    '  args: {',
    "    check: { type: 'boolean', description: 'Fail when the icons are stale instead of writing them' },",
    '  },',
    "  examples: 'kit icons\\nkit icons --check',",
    '  async run(ctx) {',
    '    const root = ctx.root ?? process.cwd()',
    "    const cmd = ['bun', 'tools/icons.ts', ...(ctx.args.check ? ['--check'] : []), ...ctx.rest]",
    '    if (ctx.flags.dryRun) {',
    "      ctx.log.info(cmd.join(' '))",
    '      return',
    '    }',
    '    await runOrThrow(cmd, { cwd: root })',
    '  },',
    '})',
    '```',
    '',
    `- Names: a repo command with a built-in's path (\`clean\`, \`deps\`, \`logs\`, \`open\`, \`config\`, \`app\`, …) is an error unless it sets \`override: true\`, which replaces the built-in. Check \`${kit} --help\` and pick another name unless replacing is the plan.`,
    '- Port the logic into TypeScript when the script is short. For a long one, keep the logic in an `_`-prefixed directory (`.kit/commands/_lib/`) or where it lives now, and make the command its only entry point.',
    "- Declare every flag the script took in `args` (`type: 'boolean'` or `'string'`, with `short` and `description`). `--json`, `--dry-run`/`-n`, `--yes`/`-y`, `--verbose`/`-v`, `--quiet`/`-q` and `--bail` are kit's global flags (`ctx.flags`); a script flag with one of those names needs another. Positionals arrive in `ctx.positionals`, arguments after `--` in `ctx.rest`.",
    "- Run children with `run`, `runOrThrow`, `runCapture`, `runLines` or `runInteractive` from `@jordond/kit`, and several steps with `commandStep` + `runSteps(steps, ctx.flags)` for kit's step tree. Pass `cwd`: the working directory is wherever the user ran kit. Keep heavy imports inside `run` so `kit --help` stays fast.",
    '- Honour `--dry-run` (`ctx.flags.dryRun`: print what would run, change nothing). Under `--json` (`ctx.flags.json`) stdout carries one JSON document: capture children with `runQuiet`, `runCapture` or `runLines` (`run` and `runOrThrow` pass their stdout through), log with `ctx.log` (stderr), and finish with `process.stdout.write(JSON.stringify(result))`.',
    '- Fail by throwing `KitError(message, hint, ExitCode.…)`, never `process.exit`. Required env vars go in `requiresEnv`.',
    '',
    '## 6. Point every caller at kit',
    '',
    '- `package.json` scripts: delete the ones kit replaces, except those step 5 keeps. Keep a script that something outside the repo calls by name (a hosting provider, another repo); make it call kit only when no kind default runs it.',
    `- CI: when kit is installed with Bun (a \`bun.lock\` at the root, or kit in \`.kit/\`), set it up with kit's action, which installs Bun and the dependencies and puts \`kit\` on PATH (inputs \`java\`, \`ruby\`, \`mise\`): \`uses: jordond/kit/.github/actions/setup@<sha> # v${version}\`, where \`<sha>\` is the commit from \`git ls-remote https://github.com/jordond/kit.git 'refs/tags/v${version}^{}'\` (or \`refs/tags/v${version}\` when that prints nothing). With another package manager, keep the repo's own install step, add \`oven-sh/setup-bun\`, and run \`./node_modules/.bin/kit\`. Replace each step's command with the kit command and keep triggers, secrets, environments and matrix. Keep the same scope: \`kit check\` and \`kit test\` where CI ran everything; \`--affected\` only with the user's yes and \`fetch-depth: 0\` on checkout.`,
    '- Deploy and release workflows: rewrite them only as the plan says, and list them as unverified in your report; you cannot run them.',
    `- Git hooks: keep the repo's hook manager (husky, lefthook, pre-commit) and make its hooks call kit by path (\`${kit} lint --staged\`, \`${kit} format --staged\`); \`kit\` may not be on PATH in a hook. Switch managers only if the user approved it.`,
    '- README, CONTRIBUTING and other docs: every command they show becomes the kit command.',
    '- Delete each script, Makefile recipe and task file that is now a kit command or config field. Nothing should be left that does the same job as a kit command.',
    '',
    '## 7. Tell agents',
    '',
    `Run \`${kit} agents sync\`: it writes the kit block into \`AGENTS.md\` and an \`@AGENTS.md\` import into \`CLAUDE.md\`. Remove instructions elsewhere in those files that name the old scripts. \`--hooks\` also adds a Claude Code hook that refuses direct \`./gradlew\`/\`./kotlin\` builds; add it only if the user wants it ([coding agents](${DOCS}/agents.md)).`,
    '',
    '## 8. Verify',
    '',
    `- \`${kit} doctor --ci\` passes, or every warning left is a tool this machine lacks.`,
    `- \`${kit} check\`, \`${kit} test\` and \`${kit} build\` give the baseline's results: what passed passes, what failed fails the same way. \`--dry-run\` prints the commands they run; compare them with the old ones.`,
    `- Every repo command shows in \`${kit} --help\`, and \`${kit} <name> --help\` and \`${kit} <name> --dry-run\` work. Run the ones that are safe to run.`,
    '- Every workflow file still parses, and every command in it is a kit command or has a reason not to be.',
    '- `git grep` for each deleted script name finds nothing.',
    '- `git status` is clean: everything is committed.',
    '',
    '## 9. Report',
    '',
    'Finish with the inventory table: each old script or step, what replaced it, and anything you did not migrate with the reason. Then the baseline against the final results, the workflows you could not run, what a person still has to do (CI secrets, a store credential, a machine-specific tool), the branch name and the commits you made.',
  ]
  return lines.join('\n')
}
