import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { installDir } from '../config/load'
import type { KitConfig } from '../config/schema'
import { expandProjectModules } from './module'

/**
 * What tells a coding agent to drive the repo through kit instead of `./kotlin` or `./gradlew`:
 * - the guide: a block in AGENTS.md between two markers, generated from the config, so it names
 *   this repo's targets and modules. kit owns the block and nothing else in the file.
 * - CLAUDE.md importing AGENTS.md, for Claude Code.
 * - the hook (opt-in): a Claude Code `PreToolUse` hook in `.claude/settings.json` that refuses a
 *   direct wrapper build or test and names the kit command to run instead.
 * Everything here but `guideFacts` is pure.
 */

export const AGENTS_FILE = 'AGENTS.md'
export const CLAUDE_FILE = 'CLAUDE.md'
export const SETTINGS_FILE = '.claude/settings.json'
export const BLOCK_START = '<!-- kit:start -->'
export const BLOCK_END = '<!-- kit:end -->'

export interface GuideFacts {
  /** Where the repo's own kit is when `kit` is not on PATH; undefined when kit is a root dependency. */
  localKit?: string
  /** Module names of the native build, as `-m` takes them; empty when kit cannot list them. */
  modules: string[]
}

/** The facts the guide needs from the repo besides its config. */
export function guideFacts(root: string, config: KitConfig): GuideFacts {
  const dir = installDir(root)
  const facts: GuideFacts = { modules: [] }
  if (dir !== '.') facts.localKit = `./${dir}/node_modules/.bin/kit`
  if (config.toolchain) {
    const base = join(root, config.toolchain.root)
    const yaml = join(base, 'project.yaml')
    if (existsSync(yaml)) {
      const list = (d: string) =>
        existsSync(join(base, d))
          ? [...new Bun.Glob('**/module.yaml').scanSync({ cwd: join(base, d), onlyFiles: true })]
              .filter((f) => !/(^|\/)(build|node_modules)\//.test(f))
              .map((f) => join(d, f))
          : []
      facts.modules = expandProjectModules(readFileSync(yaml, 'utf8'), list).map((m) => basename(m))
    }
  }
  return facts
}

const NATIVE = ['gradle', 'kotlin']

/** The kit block of AGENTS.md, markers included, for this config. */
export function agentGuide(config: KitConfig, facts: GuideFacts = { modules: [] }): string {
  const targets = Object.entries(config.targets)
  const native = targets.some(([, t]) => NATIVE.includes(t.kind))
  const tool = config.gradle ? './gradlew' : config.toolchain ? './kotlin' : undefined
  const passthrough = config.gradle ? 'kit gradle' : config.toolchain ? 'kit kotlin' : undefined
  const has = (verb: 'dev' | 'deploy') =>
    targets.some(([, t]) => t[verb] !== undefined && t[verb] !== false) ||
    targets.some(([, t]) => ['worker', 'vite', 'astro'].includes(t.kind))

  const rows: [string, string][] = [
    ['Build', '`kit build`'],
    ['Test', '`kit test`'],
    ...(native
      ? ([
          ['Build one module, one platform', '`kit build -m <module> -p <platform>`'],
          ['Test one module, one platform', '`kit test -m <module> -p <platform>`'],
        ] as [string, string][])
      : []),
    ['Lint and typecheck', '`kit check` (`kit check --fix` applies the fixes)'],
    ['Only what this branch changed', '`kit check --affected`, `kit test --affected`'],
    ...(has('dev') ? ([['Run a target', '`kit dev <target>`']] as [string, string][]) : []),
    ...(passthrough
      ? ([[`Anything else in \`${tool}\``, `\`${passthrough} <args>\``]] as [string, string][])
      : []),
  ]
  const lines = [
    BLOCK_START,
    '## Commands: use `kit`',
    '',
    `This repo is driven by [kit](https://github.com/jordond/kit). Build, test and lint with \`kit\`${
      tool ? `, never with \`${tool}\` directly` : ''
    }: kit picks the tool, runs it in the right directory and applies this repo's config.`,
    '',
    '| Task | Command |',
    '| --- | --- |',
    ...rows.map(([task, cmd]) => `| ${task} | ${cmd} |`),
    '',
    `- Targets: ${targets.map(([n, t]) => `\`${n}\` (${t.kind})`).join(', ')}. Name them to narrow a run: \`kit test ${targets[0]?.[0] ?? '<target>'}\`.`,
    ...(native && facts.modules.length
      ? [`- Modules: ${facts.modules.map((m) => `\`${m}\``).join(', ')}.`]
      : []),
    ...(native
      ? [
          '- `-m` and `-p` repeat (`-m core -m data -p jvm`). Platforms are named as the build tool names them: `jvm`, `android`, `iosSimulatorArm64`, `wasmJs`.',
        ]
      : []),
    '- Arguments after `--` go to the underlying tool: `kit test -- <tool arguments>`.',
    '- `--dry-run` prints the commands without running them; `--json` writes one JSON document to stdout.',
    '- `kit --help` and `kit <command> --help` list everything else.',
    ...(facts.localKit ? [`- When \`kit\` is not on PATH, run \`${facts.localKit}\`.`] : []),
    '',
    '_kit writes this block (`kit agents sync`); edit outside the markers._',
    BLOCK_END,
  ]
  return lines.join('\n')
}

/** The kit block in `text`, markers included; undefined when there is none. */
export function currentBlock(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END, start + 1)
  return start < 0 || end < 0 ? undefined : text.slice(start, end + BLOCK_END.length)
}

/** AGENTS.md with `block` in place of its kit block (appended when it has none); undefined when current. */
export function withAgentBlock(text: string | undefined, block: string): string | undefined {
  if (text === undefined || text.trim() === '') return `${block}\n`
  const old = currentBlock(text)
  if (old === block) return undefined
  if (old !== undefined) return text.replace(old, () => block)
  return `${text.replace(/\n*$/, '')}\n\n${block}\n`
}

/** CLAUDE.md importing AGENTS.md; undefined when it already mentions the file. */
export function withClaudeImport(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') return `@${AGENTS_FILE}\n`
  if (text.includes(AGENTS_FILE)) return undefined
  return `${text.replace(/\n*$/, '')}\n\n@${AGENTS_FILE}\n`
}

// ---- the hook ---------------------------------------------------------------------------------

/** The hook command in `.claude/settings.json`: the repo's own kit when it lives in `.kit/`. */
export function hookCommand(kitDir: string): string {
  return kitDir === '.'
    ? 'kit agents hook'
    : `"$CLAUDE_PROJECT_DIR"/${kitDir}/node_modules/.bin/kit agents hook`
}

const isKitHook = (command: unknown): command is string =>
  typeof command === 'string' && /\bkit agents hook\s*$/.test(command)

interface HookGroup {
  matcher?: string
  hooks?: { type?: string; command?: string }[]
}

function preToolUse(settings: unknown): HookGroup[] | undefined {
  const hooks = (settings as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse
  return Array.isArray(hooks) ? (hooks as HookGroup[]) : undefined
}

/** Whether `.claude/settings.json` already runs kit's hook. Unreadable JSON counts as no. */
export function hasAgentHook(text: string | undefined): boolean {
  if (text === undefined) return false
  try {
    return !!preToolUse(JSON.parse(text))?.some((g) => g.hooks?.some((h) => isKitHook(h.command)))
  } catch {
    return false
  }
}

/**
 * `.claude/settings.json` with kit's `PreToolUse` hook on Bash: added, or its command updated.
 * Undefined when it is already there; `'invalid'` when the file is not a JSON object.
 */
export function withAgentHook(text: string | undefined, command: string): string | 'invalid' | undefined {
  let settings: Record<string, unknown> = {}
  if (text !== undefined && text.trim() !== '') {
    try {
      settings = JSON.parse(text)
    } catch {
      return 'invalid'
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return 'invalid'
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return 'invalid'
  const groups = hooks.PreToolUse === undefined ? [] : preToolUse(settings)
  if (!groups) return 'invalid'
  const mine = groups.flatMap((g) => g.hooks ?? []).find((h) => isKitHook(h.command))
  if (mine?.command === command) return undefined
  if (mine) mine.command = command
  else groups.push({ matcher: 'Bash', hooks: [{ type: 'command', command }] })
  return `${JSON.stringify({ ...settings, hooks: { ...hooks, PreToolUse: groups } }, null, 2)}\n`
}

const base = (token: string) => token.slice(token.lastIndexOf('/') + 1)

/** `-m a --module=b` style values of `names` out of `args`; what is left is `rest`. */
function takeOptions(args: string[], names: string[]): { values: string[]; rest: string[] } {
  const values: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split(/=(.*)/s) as [string, string | undefined]
    if (!names.includes(flag)) rest.push(args[i]!)
    else if (inline !== undefined) values.push(inline)
    else if (args[i + 1] !== undefined) values.push(args[++i]!)
  }
  return { values, rest }
}

const flagged = (flag: string, values: string[]) => values.flatMap((v) => [flag, v])
const tail = (rest: string[]) => (rest.length ? ['--', ...rest] : [])

/** The kit command for `./kotlin build|test <args>`; undefined for any other wrapper command. */
function kotlinEquivalent(args: string[]): string | undefined {
  const [verb, ...more] = args
  if (verb !== 'build' && verb !== 'test') return undefined
  const modules = takeOptions(more, ['-m', '--module', '--include-module'])
  const platforms = takeOptions(modules.rest, ['-p', '--platform'])
  return [
    'kit',
    verb,
    ...flagged('-m', modules.values),
    ...flagged('-p', platforms.values),
    ...tail(platforms.rest),
  ].join(' ')
}

const GRADLE_VERBS: Record<string, string> = {
  build: 'build',
  test: 'test',
  spotlessCheck: 'lint',
  spotlessApply: 'format',
}

/**
 * The kit command for `./gradlew <tasks>` when every task is one a kit verb runs (`build`,
 * `:core:test`, `spotlessCheck`) and they are all the same verb; undefined otherwise.
 */
function gradleEquivalent(args: string[]): string | undefined {
  const tasks = args.filter((a) => !a.startsWith('-'))
  const flags = args.filter((a) => a.startsWith('-'))
  if (!tasks.length) return undefined
  const modules: string[] = []
  let verb: string | undefined
  for (const task of tasks) {
    const at = task.lastIndexOf(':')
    const mapped = GRADLE_VERBS[task.slice(at + 1)]
    const project = at > 0 ? task.slice(0, at) : ''
    if (!mapped || (verb && verb !== mapped)) return undefined
    // lint and format take no module.
    if (project && mapped !== 'build' && mapped !== 'test') return undefined
    verb = mapped
    if (project) modules.push(project)
  }
  return ['kit', verb!, ...flagged('-m', modules), ...tail(flags)].join(' ')
}

/**
 * Why a shell command an agent is about to run should not: it builds or tests through the wrapper
 * where a kit verb does the same. Undefined lets it through, which is every command kit has no
 * verb for, and anything already going through kit (`kit kotlin build …`).
 */
export function hookVerdict(command: string, config: KitConfig): string | undefined {
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    while (tokens[0] && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift()
    const [bin, ...args] = tokens
    if (!bin?.includes('/')) continue
    const wrapper = base(bin)
    const kit =
      wrapper === 'kotlin' && config.toolchain
        ? kotlinEquivalent(args)
        : wrapper === 'gradlew' && config.gradle
          ? gradleEquivalent(args)
          : undefined
    if (!kit) continue
    const passthrough = wrapper === 'kotlin' ? 'kit kotlin' : 'kit gradle'
    return [
      `Run \`${kit}\` instead of \`${[bin, ...args].join(' ')}\`.`,
      `This repo builds and tests through kit (see ${AGENTS_FILE}); \`${passthrough} <args>\` passes through what kit has no command for.`,
    ].join(' ')
  }
  return undefined
}

// ---- planning what to write -------------------------------------------------------------------

export type AgentAction =
  | { kind: 'write' | 'edit'; path: string; content: string; note: string }
  | { kind: 'skip'; path: string; reason: string }

/**
 * The files `kit agents sync` writes: the AGENTS.md block, the CLAUDE.md import, and with `hook`
 * the Claude Code hook. A file that is already right is a skip.
 */
export function planAgents(o: {
  read: (repoPath: string) => string | undefined
  block: string
  /** The hook command to install; undefined leaves `.claude/settings.json` alone. */
  hook?: string
}): AgentAction[] {
  const plan: AgentAction[] = []
  const file = (path: string, content: string | undefined, note: string) => {
    if (content === undefined) plan.push({ kind: 'skip', path, reason: 'up to date' })
    else plan.push({ kind: o.read(path) === undefined ? 'write' : 'edit', path, content, note })
  }
  const agents = o.read(AGENTS_FILE)
  file(
    AGENTS_FILE,
    withAgentBlock(agents, o.block),
    currentBlock(agents) ? 'update the kit block' : 'add the kit block',
  )
  file(CLAUDE_FILE, withClaudeImport(o.read(CLAUDE_FILE)), `import ${AGENTS_FILE}`)
  if (o.hook !== undefined) {
    const settings = withAgentHook(o.read(SETTINGS_FILE), o.hook)
    if (settings === 'invalid') {
      plan.push({ kind: 'skip', path: SETTINGS_FILE, reason: 'not a JSON object kit can add a hook to' })
    } else file(SETTINGS_FILE, settings, 'add the PreToolUse hook')
  }
  return plan
}

/**
 * `planAgents` for the repo at `root`. `hook`: true installs the hook, false leaves the settings
 * file alone, `'keep'` only updates a hook that is already installed.
 */
export function agentPlan(root: string, config: KitConfig, hook: boolean | 'keep' = 'keep'): AgentAction[] {
  const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined)
  const wanted = hook === 'keep' ? hasAgentHook(read(SETTINGS_FILE)) : hook
  return planAgents({
    read,
    block: agentGuide(config, guideFacts(root, config)),
    hook: wanted ? hookCommand(installDir(root)) : undefined,
  })
}

/** Write the non-skip actions of a plan. */
export function applyAgents(root: string, plan: AgentAction[]): void {
  for (const a of plan) {
    if (a.kind === 'skip') continue
    mkdirSync(dirname(join(root, a.path)), { recursive: true })
    writeFileSync(join(root, a.path), a.content)
  }
}
