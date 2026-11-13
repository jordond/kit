import type { Args, Command } from 'gunshi'
import { cli } from 'gunshi/bone'
import { dirname } from 'node:path'
import pc from 'picocolors'
import pkg from '../../package.json' with { type: 'json' }
import { findRoot, loadConfig, loadDotEnv } from '../config/load'
import type { KitConfig } from '../config/schema'
import { installSignalHandlers, interrupted, runCleanup } from '../lib/cleanup'
import { ExitCode, KitError } from '../lib/errors'
import { emitJson, jsonEmitted, log } from '../lib/log'
import { builtins, groupDescriptions } from './builtins'
import { computeFlags, type KitCommand, type Runtime, toGunshi, withBuiltin } from './command'
import { importRepoCommand, listRepoCommands } from './discover'
import { kitGlobals, SHOW_USAGE } from './plugin'
import { renderUsage } from './usage'

/** Shells `kit completion` supports (mirrors src/commands/completion.ts, kept here so help stays lazy). */
const SHELLS = ['zsh', 'bash', 'fish']

interface Leaf {
  path: string[]
  description: string
  group: string
  source: 'builtin' | 'repo'
  /** Repo command that replaces the built-in with the same path (known once loaded). */
  override?: boolean
  load: () => Promise<KitCommand<Args>>
}

/** Positional tokens before the first flag or `--`. */
function commandTokens(argv: string[]): string[] {
  const out: string[] = []
  for (const a of argv) {
    if (a === '--' || a.startsWith('-')) break
    out.push(a)
  }
  return out
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])
const startsWith = (a: string[], prefix: string[]) => prefix.every((s, i) => a[i] === s)

async function collectLeaves(root: string | undefined, config: KitConfig | undefined): Promise<Leaf[]> {
  const appName = config?.name
  const leaves: Leaf[] = builtins.map((b) => ({
    path: b.path,
    description: b.description,
    group: b.group,
    source: 'builtin',
    load: async () => (await b.load()).default,
  }))
  if (!root) return leaves
  // `kit release <service>` for each release.services entry.
  for (const name of Object.keys(config?.release?.services ?? {})) {
    if (leaves.some((l) => l.path[0] === 'release' && l.path[1] === name)) continue
    leaves.push({
      path: ['release', name],
      description: `Release the ${name} service`,
      group: 'Release',
      source: 'builtin',
      load: async () => (await import('../commands/release/service')).serviceCommand(name),
    })
  }
  for (const f of listRepoCommands(root)) {
    leaves.push({
      path: f.path,
      description: '',
      group: appName ?? 'Repo',
      source: 'repo',
      load: () => importRepoCommand(f),
    })
  }
  return leaves
}

/** Build a gunshi subcommand tree. Loaded leaves are real commands; the rest are help-only stubs. */
function buildTree(
  leaves: Leaf[],
  loaded: Map<Leaf, KitCommand<Args>>,
  rt: Runtime,
  depth = 0,
): Record<string, Command> {
  const tree: Record<string, Command> = {}
  const names = [...new Set(leaves.map((l) => l.path[depth] as string))]
  for (const name of names) {
    const here = leaves.filter((l) => l.path[depth] === name)
    const atDepth = here.filter((l) => l.path.length === depth + 1)
    // An overriding repo command takes the built-in's place in help and dispatch.
    const leaf =
      atDepth.find((l) => l.source === 'repo' && (l.override || loaded.get(l)?.override)) ?? atDepth[0]
    const children = here.filter((l) => l.path.length > depth + 1)
    const loadedCmd = leaf ? loaded.get(leaf) : undefined
    const base: Command & { group?: string } = loadedCmd
      ? toGunshi(name, loadedCmd, rt)
      : {
          name,
          description: leaf
            ? leaf.description || loaded.get(leaf)?.description
            : (groupDescriptions[name] ?? ''),
          group: leaf?.group ?? here[0]?.group,
          // Group node (e.g. `kit release`): show its usage. Unloaded leaves never run.
          run: () => {
            throw SHOW_USAGE
          },
        }
    if (children.length) base.subCommands = buildTree(children, loaded, rt, depth + 1)
    tree[name] = base
  }
  return tree
}

function suggest(token: string, candidates: string[]): string | undefined {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
    for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        (d[i] as number[])[j] = Math.min(
          (d[i - 1] as number[])[j]! + 1,
          (d[i] as number[])[j - 1]! + 1,
          (d[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        )
    return (d[a.length] as number[])[b.length]!
  }
  const best = candidates.map((c) => [c, dist(token, c)] as const).sort((x, y) => x[1] - y[1])[0]
  return best && best[1] <= 2 ? best[0] : undefined
}

/** Commands that must work with any kit: they inspect or repair the install, or never touch the repo. */
const ANY_COPY = ['doctor', 'upgrade', 'init', 'completion', 'complete']

/**
 * The launcher hands off to the repo's own kit, but only for the layouts its release knows: an
 * older global kit can end up running itself in a repo pinned to a newer one. Before anything of
 * the repo loads, run the repo's copy instead when there is one, and refuse to run a copy the
 * repo's pin excludes. A source checkout (`KIT_DEV`, `bun src/cli.ts`) is always left alone.
 * Returns the exit code of the handed-off run, or undefined to carry on in this process.
 */
async function ensureRepoCopy(root: string, argv: string[]): Promise<number | undefined> {
  if (process.env.KIT_DEV || process.env.KIT_HANDOFF || import.meta.path.endsWith('.ts')) return undefined
  const { copyVerdict, kitCopyAt } = await import('../lib/kit-copy')
  const own = kitCopyAt(import.meta.dir)
  if (!own) return undefined
  const verdict = copyVerdict(root, own)
  if (verdict.kind === 'ok') return undefined
  if (verdict.kind === 'handoff') {
    const child = Bun.spawn([process.execPath, '--no-env-file', verdict.cli, ...argv], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, KIT_ROOT: root, KIT_HANDOFF: '1' },
    })
    return child.exited
  }
  const tokens = commandTokens(argv)
  const message = `This repo pins ${pkg.name} "${verdict.range}" (${verdict.manifest}) but it is not installed, and this kit is ${own.version}`
  const hint = `Install the repo's kit: run the package manager's install in ${dirname(verdict.manifest) === '.' ? 'the repo root' : dirname(verdict.manifest)}`
  if (
    tokens.length === 0 ||
    ANY_COPY.includes(tokens[0]!) ||
    argv.includes('--version') ||
    argv.includes('-V')
  ) {
    if (tokens[0] !== 'complete' && tokens[0] !== 'completion') {
      log.warn(message)
      log.dim(`  › ${hint}`)
    }
    return undefined
  }
  throw new KitError(message, hint, ExitCode.precondition)
}

/** Set when the repo's own kit ran the command: that copy speaks for the run, this one stays quiet. */
let handedOff = false

/** Commands the update notice stays out of: they print scripts, or are the update itself. */
const NO_NOTICE = ['upgrade', 'completion', 'complete']

/** Tell the user when the kit on PATH is behind. Never fails or delays a command. */
async function updateNotice(argv: string[]): Promise<void> {
  const dashdash = argv.indexOf('--')
  const own = dashdash < 0 ? argv : argv.slice(0, dashdash)
  if (handedOff || own.includes('--json') || NO_NOTICE.includes(commandTokens(argv)[0] ?? '')) return
  try {
    const { notifyUpdate } = await import('../lib/self-update')
    notifyUpdate(pkg.version, (msg, hint) => {
      log.warn(msg)
      log.dim(`  › ${hint}`)
    })
  } catch {}
}

async function main(argv: string[]): Promise<number> {
  // The background child `notifyUpdate` starts: ask npm for the latest version, record it, exit.
  if (argv[0] === '__refresh-update-state') {
    await (await import('../lib/self-update')).refreshUpdateState()
    return 0
  }
  const root = findRoot()
  if (root) {
    const code = await ensureRepoCopy(root, argv)
    if (code !== undefined) {
      handedOff = true
      return code
    }
  }
  let config: KitConfig | undefined
  if (root) {
    await loadDotEnv(root)
    config = await loadConfig(root)
  }
  const rt: Runtime = { root, config }
  const leaves = await collectLeaves(root, config)
  const tokens = commandTokens(argv)

  const wantsHelp = argv.includes('--help') || argv.includes('-h')

  // `kit completion <shell>` prints a script; the script calls back `kit complete -- <words>`.
  const script = tokens[0] === 'completion' && SHELLS.includes(tokens[1] ?? '') && !wantsHelp
  if (tokens[0] === 'complete' || script) {
    // Completion needs the whole tree with args, so load every command. Only on this path.
    const { default: completion } = await import('@gunshi/plugin-completion')
    const all = new Map<Leaf, KitCommand<Args>>()
    await Promise.all(leaves.map(async (l) => all.set(l, await l.load())))
    // The plugin bakes this process's `bun <entry>` into the script; call back through the `kit` on
    // PATH instead, so the launcher picks each project's pinned kit (and works outside a project).
    if (script) Object.defineProperty(process, 'execPath', { value: 'kit', configurable: true })
    await cli(
      script ? ['complete', tokens[1]!] : argv,
      { name: 'kit', run: () => {} },
      {
        name: 'kit',
        version: pkg.version,
        subCommands: buildTree(leaves, all, rt),
        renderUsage: null,
        renderHeader: null,
        plugins: [completion()],
      },
    )
    return 0
  }

  // Resolve the single command to run: longest leaf path that prefixes the tokens. Repo wins only with override.
  const matches = leaves
    .filter((l) => startsWith(tokens, l.path))
    .sort((a, b) => b.path.length - a.path.length)
  const loaded = new Map<Leaf, KitCommand<Args>>()
  let target: Leaf | undefined
  const longest = matches[0]?.path.length
  for (const m of matches.filter((x) => x.path.length === longest)) {
    const cmd = await m.load()
    if (target && target.source === 'builtin' && m.source === 'repo' && !cmd.override) {
      throw new KitError(
        `.kit/commands/${m.path.join('/')}.ts conflicts with built-in \`kit ${m.path.join(' ')}\``,
        'Rename it, or set `override: true` to replace the built-in',
        ExitCode.usage,
      )
    }
    if (!target || (m.source === 'repo' && cmd.override)) {
      if (target) loaded.delete(target)
      target = m
      loaded.set(m, cmd)
    }
  }

  // Passthrough commands take every token after their path as-is, help flags included, except a
  // leading -h/--help: that is kit's usage (help never executes). `kit gradle tasks --help` passes.
  const picked = target && loaded.get(target)
  if (target && picked?.passthrough) {
    const rest = argv.slice(target.path.length)
    if (rest[0] !== '-h' && rest[0] !== '--help') {
      await picked.run(
        withBuiltin({ root, config, args: {}, positionals: [], rest, flags: computeFlags({}), log }),
      )
      return process.exitCode === undefined ? 0 : Number(process.exitCode)
    }
  }

  if (!target || wantsHelp) {
    // Help or unknown: load repo leaves at this level so their descriptions show.
    const level = leaves.filter(
      (l) => l.source === 'repo' && startsWith(l.path, tokens.slice(0, l.path.length - 1)),
    )
    await Promise.all(level.map(async (l) => loaded.set(l, await l.load())))
    for (const l of level) {
      l.description = loaded.get(l)?.description ?? ''
      l.override = loaded.get(l)?.override
    }
    if (!target) for (const l of level) loaded.delete(l)
  }

  if (!target && tokens.length) {
    // Find the first token that no command path continues with.
    let i = 0
    while (i < tokens.length && leaves.some((l) => same(l.path.slice(0, i + 1), tokens.slice(0, i + 1)))) i++
    const isGroup = i === tokens.length
    if (!isGroup) {
      const prefix = tokens.slice(0, i)
      const options = [...new Set(leaves.filter((l) => startsWith(l.path, prefix)).map((l) => l.path[i]!))]
      const guess = suggest(tokens[i]!, options)
      throw new KitError(
        `Unknown command "${tokens.slice(0, i + 1).join(' ')}".${guess ? ` Did you mean "${[...prefix, guess].join(' ')}"?` : ''}`,
        `Run \`kit ${prefix.length ? `${prefix.join(' ')} ` : ''}--help\` to list commands`,
        ExitCode.usage,
      )
    }
  }

  // A command that also has subcommands (`kit shots <target>` beside `kit shots export`): gunshi
  // reports the first positional of such a command as "Command not found". Run it from a tree
  // without its children; its own `--help` (no positional) keeps them so they are listed.
  const own = target
  const listsChildren = wantsHelp && own !== undefined && tokens.length === own.path.length
  const treeLeaves =
    own && !listsChildren
      ? leaves.filter((l) => !(l.path.length > own.path.length && startsWith(l.path, own.path)))
      : leaves
  const subCommands = buildTree(treeLeaves, loaded, rt)
  const entry: Command = {
    name: 'kit',
    description: config ? `kit · ${config.name}` : 'kit',
    run: () => {},
  }
  await cli(argv, entry, {
    name: 'kit',
    version: pkg.version,
    description: 'One dev toolkit for every app',
    subCommands,
    renderUsage: null,
    renderHeader: null,
    renderValidationErrors: null,
    plugins: [kitGlobals(pkg.version, renderUsage)],
  })
  return process.exitCode === undefined ? 0 : Number(process.exitCode)
}

installSignalHandlers()
try {
  process.exitCode = await main(process.argv.slice(2))
  await updateNotice(process.argv.slice(2))
} catch (e) {
  // --json promises exactly one document on stdout, failures included.
  const argv = process.argv.slice(2)
  const dashdash = argv.indexOf('--')
  if ((dashdash < 0 ? argv : argv.slice(0, dashdash)).includes('--json') && !jsonEmitted()) {
    emitJson({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ...(e instanceof KitError && e.hint ? { hint: e.hint } : {}),
      exitCode: e instanceof KitError ? e.exitCode : ExitCode.failed,
    })
  }
  if (e instanceof KitError) {
    log.error(e.message, e.hint)
    process.exitCode = e.exitCode
  } else {
    log.error(e instanceof Error ? e.message : String(e))
    if (process.env.DEBUG?.includes('kit') && e instanceof Error) log.dim(e.stack ?? '')
    else log.dim(`  ${pc.dim('re-run with DEBUG=kit for a stack trace')}`)
    process.exitCode = ExitCode.failed
  }
}
// After the catch: a command that throws because of the interrupt still exits 130.
if (interrupted()) process.exitCode = ExitCode.interrupted
await runCleanup()
