import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Remove build output',
  group: 'Develop',
  args: {
    deep: {
      type: 'boolean',
      description: 'Also node_modules, .wrangler/state (local D1/KV data) and Xcode DerivedData',
    },
  },
  examples: 'kit clean\nkit clean client\nkit clean --dry-run\nkit clean --deep --yes',
  async run(ctx) {
    const { requireProject } = await import('../cli/command')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { formatBytes, iosOutputTracked, planClean, removeItems } = await import('../lib/clean')
    const { emitJson } = await import('../lib/log')
    const { confirm } = await import('../lib/prompt')
    const pc = (await import('picocolors')).default
    const { root, config } = requireProject(ctx)

    const outputDir = process.env.KIT_OUTPUT_DIR || undefined
    const { items, refused } = planClean(root, config, {
      targets: ctx.positionals,
      deep: ctx.args.deep === true,
      outputDir,
      outputTracked: await iosOutputTracked(root, config, outputDir),
    })
    for (const r of refused) ctx.log.warn(`not removing ${r.path}: ${r.reason}`)
    const doc = (list: typeof items) => list.map((i) => ({ path: i.label, bytes: i.bytes }))
    const sum = (list: typeof items) => list.reduce((n, i) => n + i.bytes, 0)
    const total = sum(items)

    if (!items.length) {
      if (ctx.flags.json) emitJson({ ok: true, removed: [], bytes: 0 })
      else ctx.log.info('Nothing to clean')
      return
    }
    if (!ctx.flags.json) {
      const width = Math.max(...items.map((i) => formatBytes(i.bytes).length))
      for (const i of items) {
        const note = i.note ? `  ${pc.yellow(i.note)}` : ''
        ctx.log.info(`  ${pc.dim(formatBytes(i.bytes).padStart(width))}  ${i.label}${note}`)
      }
    }
    const count = `${items.length} ${items.length === 1 ? 'path' : 'paths'} (${formatBytes(total)})`
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ dryRun: true, removed: [], plan: doc(items), bytes: total })
      else ctx.log.info(`Would remove ${count}`)
      return
    }

    const noted = items.filter((i) => i.note)
    const warning = noted.length
      ? ` This deletes ${noted.map((i) => `${i.label} (${i.note})`).join(', ')}.`
      : ''
    if (!(await confirm(ctx.flags, `Remove ${count}?${warning}`))) {
      throw new KitError('Cancelled', undefined, ExitCode.interrupted)
    }
    const { removed, failed } = removeItems(root, items)
    for (const f of failed) ctx.log.error(`could not remove ${f.item.label}: ${f.error}`)
    if (ctx.flags.json) {
      emitJson({
        ok: !failed.length,
        removed: doc(removed),
        bytes: sum(removed),
        ...(failed.length ? { failed: failed.map((f) => ({ path: f.item.label, error: f.error })) } : {}),
      })
    } else if (removed.length) {
      ctx.log.success(
        `removed ${removed.length} ${removed.length === 1 ? 'path' : 'paths'}, freed ${formatBytes(sum(removed))}`,
      )
    }
    if (failed.length) process.exitCode = ExitCode.failed
  },
})
