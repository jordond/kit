import type { Command, CommandContext } from 'gunshi'
import pc from 'picocolors'

const GROUP_ORDER = ['Develop', 'Quality', 'Release', 'Infra', 'Setup']

type AnyCommand = Command & { group?: string }

function childrenOf(ctx: Readonly<CommandContext>): Map<string, AnyCommand> {
  let level = ctx.env.subCommands as Map<string, AnyCommand> | undefined
  for (const seg of ctx.commandPath ?? []) {
    const next = level?.get(seg)?.subCommands
    level = next ? new Map(Object.entries(next) as [string, AnyCommand][]) : undefined
  }
  return level ?? new Map()
}

/** Grouped, colourised usage: built-in groups first, then the app's own group. */
export async function renderUsage(ctx: Readonly<CommandContext>): Promise<string> {
  const path = ['kit', ...(ctx.commandPath ?? [])].join(' ')
  const lines: string[] = []
  if (ctx.description) lines.push(ctx.description, '')

  const children = childrenOf(ctx)
  const hasRun = typeof (ctx as unknown as { env: unknown }) === 'object' && ctx.commandPath.length > 0
  lines.push(pc.bold('Usage'), `  ${pc.cyan(path)}${children.size ? ' <command>' : ''} [options]`, '')

  if (children.size) {
    const groups = new Map<string, [string, AnyCommand][]>()
    for (const [name, cmd] of children) {
      if (cmd.internal || cmd.entry || name === ctx.env.name) continue
      const g = ctx.commandPath.length ? 'Commands' : (cmd.group ?? 'Other')
      groups.set(g, [...(groups.get(g) ?? []), [name, cmd]])
    }
    const order = [...groups.keys()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a)
      const ib = GROUP_ORDER.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
    })
    const width = Math.max(...[...children.keys()].map((n) => n.length)) + 2
    for (const g of order) {
      lines.push(pc.bold(g))
      for (const [name, cmd] of groups.get(g) ?? []) {
        const more = cmd.subCommands ? pc.dim(' …') : ''
        lines.push(`  ${pc.cyan(name.padEnd(width))}${cmd.description ?? ''}${more}`)
      }
      lines.push('')
    }
  }

  const args = Object.entries(ctx.args ?? {})
  if (args.length && (hasRun || !children.size)) {
    lines.push(pc.bold('Options'))
    const rows = args.map(([name, a]) => {
      const flag = a.type === 'positional' ? `<${name}>` : `${a.short ? `-${a.short}, ` : '    '}--${name}`
      const value = a.type === 'string' || a.type === 'number' || a.type === 'enum' ? ` <${a.type}>` : ''
      return [`${flag}${value}`, a.description ?? ''] as const
    })
    const w = Math.max(...rows.map(([f]) => f.length)) + 2
    for (const [f, d] of rows) lines.push(`  ${f.padEnd(w)}${pc.dim(d)}`)
    lines.push('')
  }
  return lines.join('\n')
}
