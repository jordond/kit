import { defineCommand } from '../../cli/command'

/**
 * `kit add maestro`: the starter Maestro flows directory (config.yaml, a smoke flow, the settle
 * subflow, a README with the rules) at `maestro.dir`, and the `maestro` block in kit.config.ts when
 * the config has none. Planning is src/lib/add/maestro.ts; the files are templates/add/maestro.
 * Files that exist are kept (`--force` replaces them), so a second run writes nothing.
 */
export default defineCommand({
  description: 'Scaffold the Maestro flows directory: smoke flow, settle subflow, README with the rules',
  group: 'Setup',
  args: {
    dir: {
      type: 'string',
      description: 'Flows directory, relative to the repo root (default: maestro.dir, else maestro)',
    },
    ios: {
      type: 'string',
      description: 'iOS bundle id (default: app.ios.bundleId or release.ios.bundleIds)',
    },
    android: {
      type: 'string',
      description: 'Android package name (default: app.android.packageName or release.android.packageName)',
    },
    force: { type: 'boolean', description: 'Overwrite files that already exist' },
  },
  examples: [
    'kit add maestro',
    'kit add maestro --dir apps/client/maestro --ios app.example --android app.example',
    'kit add maestro --dry-run --json',
  ].join('\n'),
  async run(ctx) {
    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { CONFIG_FILE, configFile } = await import('../../config/load')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { addTemplates, applyAdd } = await import('../../lib/add/apply')
    const { DEFAULT_MAESTRO_DIR, planMaestro, validateAppId } = await import('../../lib/add/maestro')
    const { parseDir } = await import('../../lib/add/plan')
    const { resolveSuite } = await import('../../lib/maestro/suites')
    const { text } = await import('../../lib/prompt')
    const { kitPackageRoot } = await import('../init')
    const { root, config } = requireProject(ctx)

    if (ctx.positionals.length) {
      throw new KitError(`Unexpected argument "${ctx.positionals[0]}"`, 'kit add maestro', ExitCode.usage)
    }
    let dir = config.maestro?.dir
    if (ctx.args.dir !== undefined) {
      const wanted = parseDir(ctx.args.dir)
      if (dir !== undefined && parseDir(dir) !== wanted) {
        throw new KitError(
          `--dir "${wanted}" differs from maestro.dir "${dir}" in the config`,
          'Change maestro.dir in kit.config.ts, or drop --dir',
          ExitCode.usage,
        )
      }
      dir = wanted
    }
    dir = parseDir(dir ?? DEFAULT_MAESTRO_DIR, 'maestro.dir')

    // An explicit flag wins; then the app block, then the release block; then a question.
    let ios = ctx.args.ios ?? config.app?.ios?.bundleId ?? config.release?.ios?.bundleIds[0]
    let android = ctx.args.android ?? config.app?.android?.packageName ?? config.release?.android?.packageName
    if (ios === undefined && android === undefined) {
      const asked = await text(ctx.flags, 'App id (bundle id / package name)', {
        placeholder: 'com.example.app',
        hint: 'Pass --ios <bundle id> and/or --android <package name>, or set app.ios / app.android in kit.config.ts',
        validate: (v) => (/^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(v) ? undefined : 'e.g. com.example.app'),
      })
      ios = android = asked.trim()
    }
    if (ios !== undefined) validateAppId(ios, ctx.args.ios !== undefined ? '--ios' : 'the iOS bundle id')
    if (android !== undefined) {
      validateAppId(android, ctx.args.android !== undefined ? '--android' : 'the Android package name')
    }

    // The smoke flow carries the tags the `qa` suite runs, so `kit qa` finds it.
    let tags = ['smoke']
    if (config.maestro) tags = [...new Set(resolveSuite(config, 'qa').stages[0] ?? tags)]

    const file = configFile(root) ?? CONFIG_FILE
    const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined)
    const plan = planMaestro({
      dir,
      ios,
      android,
      tags,
      configFile: file,
      hasBlock: config.maestro !== undefined,
      templates: addTemplates(kitPackageRoot()),
      read,
      force: ctx.args.force === true,
    })
    const platforms = [ios !== undefined ? 'ios' : undefined, android !== undefined ? 'android' : undefined]
    await applyAdd(ctx, root, plan, {
      add: 'maestro',
      name: 'maestro',
      dir,
      next: [
        `Replace SETTLED in ${join(dir, 'flows/smoke.yaml')} with text from your first screen`,
        'kit lint maestro',
        ...platforms.filter((p) => p !== undefined).map((p) => `kit qa ${p}`),
      ],
      configFile: file,
    })
  },
})
