import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Show version names (from the catalog TOML) and the last release tags',
  group: 'Release',
  examples: 'kit version show\nkit version show ios\nkit version show --json',
  async run(ctx) {
    const { requireProject } = await import('../../cli/command')
    const { readVersions, versionKey } = await import('../../lib/release/version')
    const { describe } = await import('../../lib/git')
    const { emitJson } = await import('../../lib/log')
    const { root, config } = requireProject(ctx)
    const all = readVersions(root, config)
    const names = ctx.positionals.length ? ctx.positionals : Object.keys(all)
    for (const n of names) versionKey(config, n)
    const rows = await Promise.all(
      names.map(async (name) => ({
        name,
        key: config.versions!.keys[name]!,
        version: all[name]!,
        lastTag: (await describe(`${name}/v*`, { cwd: root }).catch(() => undefined)) ?? null,
      })),
    )
    if (ctx.flags.json) {
      emitJson({ file: config.versions!.file, versions: rows })
      return
    }
    const w = Math.max(...rows.map((r) => r.name.length))
    for (const r of rows) {
      process.stdout.write(
        `${r.name.padEnd(w)}  ${r.version}${r.lastTag ? `  (last tag ${r.lastTag})` : ''}\n`,
      )
    }
  },
})
