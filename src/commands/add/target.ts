import { defineCommand } from '../../cli/command'

/**
 * `kit add target <name> --kind <kind> --dir <path>`: one more entry in the config's
 * `targets: { … }`, by a text edit that keeps the file as written (src/lib/add/edits.ts). A config
 * kit cannot edit safely is left alone: the line to paste is printed and the exit code is 1.
 * A `worker` whose directory does not exist yet gets a minimal one (templates/add/worker).
 */
export default defineCommand({
  description: 'Add a target to kit.config.ts; a new worker also gets a minimal scaffold',
  group: 'Setup',
  args: {
    kind: { type: 'string', description: 'worker | vite | astro | docker | custom' },
    dir: { type: 'string', description: 'Target directory, relative to the repo root' },
  },
  examples: [
    'kit add target api --kind worker --dir apps/api',
    'kit add target web --kind astro --dir apps/web',
    'kit add target api --kind worker --dir apps/api --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { existsSync, readFileSync, statSync } = await import('node:fs')
    const { join, relative } = await import('node:path')
    const { builtins } = await import('../../cli/builtins')
    const { listRepoCommands } = await import('../../cli/discover')
    const { requireProject } = await import('../../cli/command')
    const { CONFIG_FILE, configFile } = await import('../../config/load')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { addTemplates, applyAdd } = await import('../../lib/add/apply')
    const { ADD_KINDS, parseDir, planTarget, validateTargetName } = await import('../../lib/add/plan')
    const { kitPackageRoot } = await import('../init')
    type AddKind = (typeof ADD_KINDS)[number]
    const { root, config } = requireProject(ctx)

    const example = 'kit add target api --kind worker --dir apps/api'
    const [name, ...extra] = ctx.positionals
    if (!name || extra.length) {
      throw new KitError(
        name ? `Unexpected argument "${extra[0]}"` : 'kit add target needs a target name',
        example,
        ExitCode.usage,
      )
    }
    const kind = ctx.args.kind
    if (kind === undefined || !(ADD_KINDS as readonly string[]).includes(kind)) {
      throw new KitError(
        kind === undefined ? 'kit add target needs --kind' : `Unknown kind "${kind}"`,
        kind === 'gradle' || kind === 'kotlin'
          ? `${kind} targets come from \`kit init\`; for a module use \`kit add module\``
          : `Use one of: ${ADD_KINDS.join(', ')}`,
        ExitCode.usage,
      )
    }
    if (ctx.args.dir === undefined) throw new KitError('kit add target needs --dir', example, ExitCode.usage)
    const dir = parseDir(ctx.args.dir)
    validateTargetName(
      name,
      Object.keys(config.targets),
      [...new Set(builtins.map((b) => b.path[0]!)), 'help'],
      listRepoCommands(root).map((c) => ({ path: c.path, file: relative(root, c.file) })),
    )
    if (existsSync(join(root, dir)) && !statSync(join(root, dir)).isDirectory()) {
      throw new KitError(`--dir "${dir}" is a file`, undefined, ExitCode.usage)
    }

    const file = configFile(root) ?? CONFIG_FILE
    const scaffolds = kind === 'worker' && !existsSync(join(root, dir))
    const plan = planTarget({
      name,
      kind: kind as AddKind,
      dir,
      configFile: file,
      exists: (p) => existsSync(join(root, p)),
      date: new Date().toISOString().slice(0, 10),
      templates: addTemplates(kitPackageRoot()),
      read: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined),
    })
    await applyAdd(ctx, root, plan, {
      add: 'target',
      name,
      dir,
      // A new worker needs its dependencies and `wrangler types` first: `kit init` runs both.
      next: [...(scaffolds ? ['kit init'] : []), `kit build ${name}`],
      configFile: file,
      target: { kind, dir },
    })
  },
})
