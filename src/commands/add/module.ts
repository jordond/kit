import { defineCommand } from '../../cli/command'

/**
 * `kit add module <name>`: a KMP library module in the repo's native build. With Gradle
 * (`gradle.root`) it is built on kit's plugins only (`kit.kmp.library`, `kit.compose`) and included
 * from the settings file; with the Kotlin toolchain (`toolchain.root`) it is a `kmp/lib`
 * module.yaml listed in project.yaml. Planning is src/lib/add/plan.ts, the edits src/lib/add/edits.ts.
 */
export default defineCommand({
  description: 'Add a KMP library module to the Gradle build or the Kotlin toolchain project',
  group: 'Setup',
  args: {
    compose: { type: 'boolean', description: 'Compose Multiplatform module (applies kit.compose)' },
    targets: {
      type: 'string',
      description: 'Comma-separated: android, ios, jvm, js (default android,ios,jvm)',
    },
    dir: {
      type: 'string',
      description: 'Module directory, relative to the Gradle or toolchain root (default: the name)',
    },
    force: { type: 'boolean', description: 'Overwrite files that already exist' },
  },
  examples: [
    'kit add module core',
    'kit add module feature:login --compose   # <gradle root>/feature/login',
    'kit add module data --targets android,jvm --dry-run',
    'kit add module ui --dir libs/ui',
  ].join('\n'),
  async run(ctx) {
    const { existsSync, readFileSync } = await import('node:fs')
    const { basename, join } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { addTemplates, applyAdd } = await import('../../lib/add/apply')
    const { parseDir, parseModulePath, parseModuleTargets, planGradleModule, planToolchainModule } =
      await import('../../lib/add/plan')
    const { detectToolchain, placeholderId } = await import('../../lib/scaffold')
    const { getTomlValue } = await import('../../lib/toml')
    const { kitPackageRoot } = await import('../init')
    const { root, config } = requireProject(ctx)

    const [name, ...extra] = ctx.positionals
    if (!name || extra.length) {
      throw new KitError(
        name ? `Unexpected argument "${extra[0]}"` : 'kit add module needs a module name',
        'kit add module feature:login --compose',
        ExitCode.usage,
      )
    }
    if (!config.gradle && !config.toolchain) {
      throw new KitError(
        'kit add module needs a native build: gradle.root or toolchain.root in kit.config.ts',
        'For a worker or a web app, use `kit add target`',
        ExitCode.config,
      )
    }
    const targets = parseModuleTargets(ctx.args.targets)
    const dir = ctx.args.dir === undefined ? undefined : parseDir(ctx.args.dir)
    const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined)
    const common = {
      targets,
      compose: ctx.args.compose === true,
      dir,
      templates: addTemplates(kitPackageRoot()),
      read,
      force: ctx.args.force === true,
    }
    const native = Object.entries(config.targets).find(([, t]) => t.kind === 'gradle' || t.kind === 'kotlin')
    const build = native ? [`kit build ${native[0]}`] : []

    if (config.gradle) {
      const gradleRoot = config.gradle.root
      const segments = parseModulePath(name)
      const settings = ['settings.gradle.kts', 'settings.gradle']
        .map((f) => join(gradleRoot, f))
        .find((f) => existsSync(join(root, f)))
      if (!settings) {
        throw new KitError(
          `No settings.gradle.kts in ${gradleRoot}`,
          'Create the Gradle build first (`kit init --template gradle` writes one)',
          ExitCode.precondition,
        )
      }
      // The plugin reads `app-name` from the catalog for the namespace: the package starts the same way.
      const catalog = read(join(gradleRoot, 'gradle/libs.versions.toml'))
      let catalogName: unknown
      try {
        catalogName = catalog === undefined ? undefined : getTomlValue(catalog, 'versions', 'app-name')
      } catch {}
      let appName: string
      if (typeof catalogName === 'string' && catalogName) {
        appName = catalogName
      } else {
        appName = placeholderId(config.name)
        if (!ctx.flags.json) {
          ctx.log.warn(`no app-name in ${join(gradleRoot, 'gradle/libs.versions.toml')}: using ${appName}`)
        }
      }
      const plan = planGradleModule({
        ...common,
        segments,
        root: gradleRoot,
        appName,
        settings,
      })
      const path = segments.join(':')
      await applyAdd(ctx, root, plan, {
        add: 'module',
        name: `:${path}`,
        dir: join(gradleRoot, dir ?? segments.join('/')),
        next: [`kit gradle :${path}:assemble`, ...build],
      })
      return
    }

    const toolchainRoot = config.toolchain!.root
    const segments = parseModulePath(name, false)
    // The toolchain names a module after its directory.
    if (dir !== undefined && basename(dir) !== name) {
      throw new KitError(
        `--dir "${dir}" must end in the module name (${name})`,
        'The Kotlin toolchain names a module after its directory',
        ExitCode.usage,
      )
    }
    const inRoot = (p: string) => join(toolchainRoot, p)
    const facts = detectToolchain(
      (p) => read(inRoot(p)),
      (d) =>
        existsSync(join(root, inRoot(d)))
          ? [...new Bun.Glob('**/*').scanSync({ cwd: join(root, inRoot(d)), onlyFiles: true })]
              .filter((f) => !/(^|\/)(build|node_modules)\//.test(f))
              .map((f) => join(d, f))
          : [],
    )
    const appName = facts.android?.packageName ?? facts.ios?.bundleId ?? placeholderId(config.name)
    const plan = planToolchainModule({ ...common, segments, root: toolchainRoot, appName })
    await applyAdd(ctx, root, plan, {
      add: 'module',
      name,
      dir: join(toolchainRoot, dir ?? name),
      next: [`kit kotlin build -m ${name}`, ...build],
    })
  },
})
