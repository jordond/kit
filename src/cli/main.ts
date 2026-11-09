import type { Args, Command } from 'gunshi'
import { cli } from 'gunshi/bone'
import pc from 'picocolors'
import pkg from '../../package.json' with { type: 'json' }
import { findRoot, loadConfig, loadDotEnv } from '../config/load'
import type { KitConfig } from '../config/schema'
import { ExitCode, KitError } from '../lib/errors'
import { log } from '../lib/log'
import { builtins, groupDescriptions } from './builtins'
import { type KitCommand, type Runtime, toGunshi } from './command'
import { importRepoCommand, listRepoCommands } from './discover'
import { kitGlobals, SHOW_USAGE } from './plugin'
import { renderUsage } from './usage'

interface Leaf {
  path: string[]
  description: string
  group: string
  source: 'builtin' | 'repo'
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

async function collectLeaves(root: string | undefined, appName: string | undefined): Promise<Leaf[]> {
  const leaves: Leaf[] = builtins.map((b) => ({
    path: b.path,
    description: b.description,
    group: b.group,
    source: 'builtin',
    load: async () => (await b.load()).default,
  }))
  if (!root) return leaves
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
    const leaf = here.find((l) => l.path.length === depth + 1)
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

async function main(argv: string[]): Promise<number> {
  const root = findRoot()
  let config: KitConfig | undefined
  if (root) {
    await loadDotEnv(root)
    config = await loadConfig(root)
  }
  const rt: Runtime = { root, config }
  const leaves = await collectLeaves(root, config?.name)
  const tokens = commandTokens(argv)

  if (tokens[0] === 'complete') {
    // Completion needs the whole tree with args, so load every command. Only on this path.
    const { default: completion } = await import('@gunshi/plugin-completion')
    const all = new Map<Leaf, KitCommand<Args>>()
    await Promise.all(leaves.map(async (l) => all.set(l, await l.load())))
    await cli(
      argv,
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

  const wantsHelp = argv.includes('--help') || argv.includes('-h')
  if (!target || wantsHelp) {
    // Help or unknown: load repo leaves at this level so their descriptions show.
    const level = leaves.filter(
      (l) => l.source === 'repo' && startsWith(l.path, tokens.slice(0, l.path.length - 1)),
    )
    await Promise.all(level.map(async (l) => loaded.set(l, await l.load())))
    for (const l of level) l.description = loaded.get(l)?.description ?? ''
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

  const subCommands = buildTree(leaves, loaded, rt)
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

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (e) {
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
