import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { addTemplates } from '../../src/lib/add/apply'
import {
  configTargets,
  includedProjects,
  withInclude,
  withProjectModule,
  withTarget,
} from '../../src/lib/add/edits'
import {
  kotlinPackage,
  modulePackage,
  parseDir,
  parseModulePath,
  parseModuleTargets,
  planGradleModule,
  planTarget,
  planToolchainModule,
  validateTargetName,
} from '../../src/lib/add/plan'
import { stripJsonc } from '../../src/lib/cloudflare'
import { KitError } from '../../src/lib/errors'
import { moduleProduct, projectModules } from '../../src/lib/scaffold'

const KIT = resolve(import.meta.dir, '../..')
const templates = addTemplates(KIT)
const reader = (files: Record<string, string>) => (p: string) => files[p]
const usage = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof KitError ? e.exitCode : e
  }
  return 'no error'
}

describe('withInclude (settings.gradle.kts)', () => {
  const settings = readFileSync(join(KIT, 'templates/gradle/apps/client/settings.gradle.kts'), 'utf8')

  test('adds a line after the last include and leaves the rest byte-identical', () => {
    const out = withInclude(settings, 'core')!
    expect(out).toBe(
      settings.replace('include(":shared", ":android")', 'include(":shared", ":android")\ninclude(":core")'),
    )
    expect(includedProjects(out)).toEqual(['shared', 'android', 'core'])
  })

  test('is a no-op when the project is already included, however it is written', () => {
    expect(withInclude(settings, 'shared')).toBeUndefined()
    expect(withInclude(settings, ':android')).toBeUndefined()
    expect(withInclude(withInclude(settings, 'feature:login')!, ':feature:login')).toBeUndefined()
    expect(withInclude('include(\n    ":a",\n    ":b:c",\n)\n', 'b:c')).toBeUndefined()
    expect(withInclude("include ':a', ':b'\n", 'b')).toBeUndefined()
  })

  test('includeBuild and commented includes do not count', () => {
    const text = 'includeBuild("core")\n// include(":core")\n'
    expect(includedProjects(text)).toEqual([])
    expect(withInclude(text, 'core')).toBe(`${text}\ninclude(":core")\n`)
  })

  test('odd formatting: multi-line list, trailing comment, indentation, no final newline', () => {
    expect(withInclude('include(\n    ":a",\n    ":b",\n) // apps\nrootProject.name = "x"', 'c')).toBe(
      'include(\n    ":a",\n    ":b",\n) // apps\ninclude(":c")\nrootProject.name = "x"',
    )
    expect(withInclude('if (ci) {\n    include(":a")\n}', 'b')).toBe(
      'if (ci) {\n    include(":a")\n    include(":b")\n}',
    )
    expect(withInclude('rootProject.name = "x"', 'a')).toBe('rootProject.name = "x"\n\ninclude(":a")\n')
    expect(withInclude('', 'a')).toBe('include(":a")\n')
  })

  test('a directory that is not the path gets a projectDir line', () => {
    expect(withInclude('include(":a")\n', 'ui', 'libs/ui')).toBe(
      'include(":a")\ninclude(":ui")\nproject(":ui").projectDir = file("libs/ui")\n',
    )
  })
})

describe('withProjectModule (project.yaml)', () => {
  test('block list: appended in the list style, idempotent', () => {
    const yaml = 'modules:\n  - androidApp\n  - shared\n'
    const out = withProjectModule(yaml, 'core') as string
    expect(out).toBe('modules:\n  - androidApp\n  - shared\n  - core\n')
    expect(projectModules(out)).toEqual(['androidApp', 'shared', 'core'])
    expect(withProjectModule(out, 'core')).toBeUndefined()
  })

  test('keeps ./ prefixes, comments, indentation and what follows the list', () => {
    const yaml = '# apps\nmodules:\n    - ./app # main\n\n    - "./shared"\n\nplugins:\n  - ./x\n'
    expect(withProjectModule(yaml, 'core')).toBe(
      '# apps\nmodules:\n    - ./app # main\n\n    - "./shared"\n    - ./core\n\nplugins:\n  - ./x\n',
    )
    expect(withProjectModule(yaml, 'shared')).toBeUndefined()
    expect(withProjectModule(yaml, 'app')).toBeUndefined()
  })

  test('a glob entry that matches the directory already covers it', () => {
    expect(withProjectModule('modules:\n  - ./libs/*\n', 'libs/core')).toBeUndefined()
    expect(withProjectModule('modules:\n  - ./libs/*\n', 'core')).toBe('modules:\n  - ./libs/*\n  - ./core\n')
  })

  test('flow list on one line, empty list, and no modules key', () => {
    expect(withProjectModule('modules: [app, shared] # all\n', 'core')).toBe(
      'modules: [app, shared, core] # all\n',
    )
    expect(withProjectModule('modules: [app, shared]\n', 'shared')).toBeUndefined()
    expect(withProjectModule('modules: []\n', 'core')).toBe('modules: [core]\n')
    expect(withProjectModule('modules:\n', 'core')).toBe('modules:\n  - core\n')
    expect(withProjectModule('plugins:\n  - x\n', 'core')).toBe('plugins:\n  - x\n\nmodules:\n  - core\n')
  })

  test('a shape it does not know is manual', () => {
    expect(withProjectModule('modules: [\n  app,\n]\n', 'core')).toBe('manual')
    expect(withProjectModule('modules: *shared\n', 'core')).toBe('manual')
  })
})

describe('withTarget (kit.config.ts)', () => {
  const api = { kind: 'worker', dir: 'apps/api' }
  const edited = (text: string, name = 'api') => {
    const r = withTarget(text, name, api)
    return r.status === 'edited' ? r.content : r.status
  }

  test('multi-line targets: a new line in the same indent, everything else untouched', () => {
    const text = readFileSync(join(KIT, 'templates/gradle/kit.config.ts'), 'utf8')
    const line = "    client: { kind: 'gradle', dir: 'apps/client' },\n"
    expect(edited(text)).toBe(text.replace(line, `${line}    api: { kind: 'worker', dir: 'apps/api' },\n`))
    expect(configTargets(edited(text))).toEqual(['client', 'api'])
  })

  test('adds the missing trailing comma, before a trailing comment', () => {
    const text = "export default {\n  targets: {\n    a: { kind: 'custom', dir: 'a' } // last\n  },\n}\n"
    expect(edited(text)).toBe(
      "export default {\n  targets: {\n    a: { kind: 'custom', dir: 'a' }, // last\n    api: { kind: 'worker', dir: 'apps/api' },\n  },\n}\n",
    )
  })

  test('inline targets, empty targets, tabs and double quotes', () => {
    expect(
      edited("export default defineConfig({ name: 'x', targets: { a: { kind: 'kotlin', dir: '.' } } })"),
    ).toBe(
      "export default defineConfig({ name: 'x', targets: { a: { kind: 'kotlin', dir: '.' }, api: { kind: 'worker', dir: 'apps/api' } } })",
    )
    expect(edited('export default {\n  targets: {},\n}\n')).toBe(
      "export default {\n  targets: { api: { kind: 'worker', dir: 'apps/api' } },\n}\n",
    )
    expect(
      edited('export default {\n\tname: "x",\n\ttargets: {\n\t\ta: { kind: "custom", dir: "a" },\n\t},\n}\n'),
    ).toBe(
      'export default {\n\tname: "x",\n\ttargets: {\n\t\ta: { kind: "custom", dir: "a" },\n\t\tapi: { kind: "worker", dir: "apps/api" },\n\t},\n}\n',
    )
  })

  test('no targets yet: the object is added as the last property', () => {
    expect(edited("export default {\n  name: 'x',\n  gradle: { root: '.' }\n}\n")).toBe(
      "export default {\n  name: 'x',\n  gradle: { root: '.' },\n  targets: {\n    api: { kind: 'worker', dir: 'apps/api' },\n  },\n}\n",
    )
    expect(edited("export default { name: 'x' }\n")).toBe(
      "export default { name: 'x', targets: { api: { kind: 'worker', dir: 'apps/api' } } }\n",
    )
  })

  test('braces and the word targets inside strings and comments are not the object', () => {
    const text = [
      '// targets: { nope: {} }',
      'export default {',
      "  name: 'targets: {',",
      '  /* targets: { } */',
      '  targets: {',
      "    'my-app': { kind: 'custom', dir: '}{', build: ['a, b', \"}\"] },",
      '  },',
      '}',
      '',
    ].join('\n')
    const out = edited(text)
    expect(out).toBe(text.replace('  },\n}', "    api: { kind: 'worker', dir: 'apps/api' },\n  },\n}"))
    expect(configTargets(out)).toEqual(['my-app', 'api'])
  })

  test('a name that needs quotes is quoted; an existing one is reported', () => {
    expect(edited('export default { targets: {} }', 'my-api')).toBe(
      "export default { targets: { 'my-api': { kind: 'worker', dir: 'apps/api' } } }",
    )
    expect(edited("export default { targets: { 'api': { kind: 'vite', dir: 'x' } } }")).toBe('exists')
  })

  test.each([
    ['a variable', 'const config = { targets: {} }\nexport default config\n'],
    ['a spread config', "export default { ...base, name: 'x' }\n"],
    ['a spread in targets', 'export default { targets: { ...shared } }\n'],
    ['targets from a variable', 'export default { targets }\n'],
    ['targets by reference', 'export default { targets: shared }\n'],
    ['a cast', 'export default { targets: {} as const }\n'],
    ['a wrapper call', 'export default wrap(defineConfig({ targets: {} }))\n'],
    ['a template with an expression', `export default { name: \`\${a}\`, targets: {} }\n`],
    ['unbalanced text', 'export default { targets: { a: { kind: "custom", dir: "a" }\n'],
    ['no default export', 'export const config = { targets: {} }\n'],
  ])('unsafe shape (%s): nothing edited, the snippet to paste comes back', (_, text) => {
    const r = withTarget(text, 'api', api)
    expect(r.status).toBe('manual')
    if (r.status === 'manual')
      expect(r.snippet).toMatch(/^api: \{ kind: ['"]worker['"], dir: ['"]apps\/api['"] \},$/)
  })
})

describe('names', () => {
  test('module paths: Gradle project names, `:` nests', () => {
    expect(parseModulePath('core')).toEqual(['core'])
    expect(parseModulePath(':feature:login-ui')).toEqual(['feature', 'login-ui'])
    for (const bad of ['', ':', 'a::b', '1core', 'core/ui', 'a b', 'a.b', '-a', 'a-', 'a--b', '../x']) {
      expect(usage(() => parseModulePath(bad))).toBe(2)
    }
    expect(usage(() => parseModulePath('feature:login', false))).toBe(2)
  })

  test('packages follow the plugin namespace rule (KitNamespaces.forPath)', () => {
    expect(modulePackage('com.example.app', ['core'])).toBe('com.example.app.core')
    expect(modulePackage('com.example.app', ['core', 'api', 'model'])).toBe('com.example.app.core.api.model')
    expect(modulePackage('app', ['feature', 'Login-UI'])).toBe('app.feature.login.ui')
    expect(modulePackage('app', ['core-2d'])).toBe('app.core._2d')
    expect(kotlinPackage('app.in.data.object')).toBe('app.`in`.data.`object`')
  })

  test('the plugin still derives namespaces the way modulePackage mirrors', () => {
    const kt = readFileSync(
      join(KIT, 'gradle/plugins/src/main/kotlin/io/github/jordond/kit/KitNamespaces.kt'),
      'utf8',
    )
    expect(kt).toContain(".flatMap { it.split('-', '.') }")
    expect(kt).toContain('.map { segment -> segment.lowercase().replace(Regex("[^a-z0-9_]"), "_") }')
    expect(kt).toContain('.map { if (it.first().isDigit()) "_$it" else it }')
    expect(kt).toContain('(listOf(appName) + segments).joinToString(".")')
  })

  test('module targets', () => {
    expect(parseModuleTargets(undefined)).toEqual(['android', 'ios', 'jvm'])
    expect(parseModuleTargets('js, android')).toEqual(['android', 'js'])
    expect(usage(() => parseModuleTargets('android,wasm'))).toBe(2)
    expect(usage(() => parseModuleTargets(','))).toBe(2)
  })

  test('target names: no collision with targets, commands or workspace', () => {
    const check = (n: string) => usage(() => validateTargetName(n, ['api'], ['build', 'add']))
    expect(check('web')).toBe('no error')
    expect(check('my-web_2')).toBe('no error')
    for (const bad of ['api', 'build', 'add', 'workspace', '', '2web', 'a b', 'a:b', '--x'])
      expect(check(bad)).toBe(2)
  })

  test('target names: a repo command is refused by its first token, naming the file', () => {
    const repo = [
      { path: ['whale', 'sfx'], file: '.kit/commands/whale/sfx.ts' },
      { path: ['test'], file: '.kit/commands/test.ts' },
    ]
    const check = (n: string) => {
      try {
        validateTargetName(n, [], ['test'], repo)
      } catch (e) {
        return e instanceof KitError ? `${e.exitCode} ${e.message}` : String(e)
      }
      return 'no error'
    }
    expect(check('whale')).toBe('2 "whale" is a repo command (.kit/commands/whale/sfx.ts)')
    expect(check('test')).toBe('2 "test" is a repo command (.kit/commands/test.ts)')
    expect(check('sfx')).toBe('no error')
  })

  test('dirs stay inside the repo', () => {
    expect(parseDir('./apps/api/')).toBe('apps/api')
    for (const bad of ['', '/abs', '..', '../x', 'a/../../x']) expect(usage(() => parseDir(bad))).toBe(2)
  })
})

describe('plans', () => {
  const settings = 'apps/client/settings.gradle.kts'
  const gradle = (
    over: Partial<Parameters<typeof planGradleModule>[0]> = {},
    files: Record<string, string> = {},
  ) =>
    planGradleModule({
      segments: ['feature', 'login'],
      targets: ['android', 'ios', 'jvm'],
      compose: false,
      root: 'apps/client',
      appName: 'com.example.app',
      templates,
      settings,
      read: reader({ [settings]: 'include(":shared")\n', ...files }),
      ...over,
    })

  test('gradle module: build file on kit plugins only, a placeholder in the namespace package, the include', () => {
    const plan = gradle()
    expect(plan.conflicts).toEqual([])
    expect(plan.actions.map((a) => `${a.kind} ${a.path}`)).toEqual([
      'write apps/client/feature/login/build.gradle.kts',
      'write apps/client/feature/login/src/commonMain/kotlin/com/example/app/feature/login/Placeholder.kt',
      `edit ${settings}`,
    ])
    const [build, kt, edit] = plan.actions as { content: string }[]
    expect(build!.content).toBe(
      'plugins {\n    id("io.github.jordond.kit.kmp.library")\n}\n\nkit {\n    targets {\n        android()\n        ios()\n        jvm()\n    }\n}\n',
    )
    expect(build!.content.match(/id\("([^"]+)"\)/g)).toEqual(['id("io.github.jordond.kit.kmp.library")'])
    expect(kt!.content).toStartWith('package com.example.app.feature.login\n')
    expect(kt!.content).toContain(':feature:login')
    expect(edit!.content).toBe('include(":shared")\ninclude(":feature:login")\n')
  })

  test('gradle module: --compose, --targets and --dir', () => {
    const plan = gradle({ compose: true, targets: ['js'], dir: 'libs/login' })
    const [build, , edit] = plan.actions as { path: string; content: string }[]
    expect(build!.path).toBe('apps/client/libs/login/build.gradle.kts')
    expect(build!.content).toContain(
      'id("io.github.jordond.kit.kmp.library")\n    id("io.github.jordond.kit.compose")\n}',
    )
    expect(build!.content).toContain('targets {\n        js()\n    }')
    expect(edit!.content).toContain('project(":feature:login").projectDir = file("libs/login")')
  })

  test('gradle module: existing files are conflicts, or overwritten with force; an include is kept', () => {
    const files = {
      'apps/client/feature/login/build.gradle.kts': 'old',
      [settings]: 'include(":feature:login")\n',
    }
    const plan = gradle({}, files)
    expect(plan.conflicts).toEqual(['apps/client/feature/login/build.gradle.kts'])
    const forced = gradle({ force: true }, files)
    expect(forced.conflicts).toEqual([])
    expect(forced.actions.map((a) => a.kind)).toEqual(['write', 'write', 'skip'])
  })

  const toolchain = (
    over: Partial<Parameters<typeof planToolchainModule>[0]> = {},
    yaml = 'modules:\n  - shared\n',
  ) =>
    planToolchainModule({
      segments: ['core'],
      targets: ['android', 'ios', 'jvm'],
      compose: false,
      root: '.',
      appName: 'app.example.demo',
      templates,
      read: reader({ 'project.yaml': yaml }),
      ...over,
    })

  test('toolchain module: module.yaml the detection reads, a placeholder, the project.yaml entry', () => {
    const plan = toolchain()
    expect(plan.actions.map((a) => `${a.kind} ${a.path}`)).toEqual([
      'write core/module.yaml',
      'write core/src/Placeholder.kt',
      'edit project.yaml',
    ])
    const [yaml, kt, edit] = plan.actions as { content: string }[]
    expect(yaml!.content).toBe(
      'product:\n  type: kmp/lib\n  platforms: [android, iosArm64, iosSimulatorArm64, jvm]\n',
    )
    expect(moduleProduct(yaml!.content)).toEqual({
      type: 'kmp/lib',
      platforms: ['android', 'iosArm64', 'iosSimulatorArm64', 'jvm'],
    })
    expect(kt!.content).toStartWith('package app.example.demo.core\n')
    expect(edit!.content).toBe('modules:\n  - shared\n  - core\n')
  })

  test('toolchain module: --compose enables compose; an unknown project.yaml shape is manual', () => {
    const [yaml] = toolchain({ compose: true, targets: ['jvm'] }).actions as { content: string }[]
    expect(Bun.YAML.parse(yaml!.content)).toEqual({
      product: { type: 'kmp/lib', platforms: ['jvm'] },
      settings: { compose: { enabled: true } },
    })
    expect(toolchain({}, 'modules: [\n  shared,\n]\n').manual).toEqual({
      file: 'project.yaml',
      where: 'the `modules:` list',
      snippet: '- core',
    })
  })

  const config =
    "export default {\n  name: 'x',\n  targets: {\n    web: { kind: 'vite', dir: 'apps/web' },\n  },\n}\n"
  const target = (over: Partial<Parameters<typeof planTarget>[0]> = {}) =>
    planTarget({
      name: 'api',
      kind: 'worker',
      dir: 'apps/api',
      configFile: 'kit.config.ts',
      exists: () => false,
      date: '2026-01-02',
      templates,
      read: reader({ 'kit.config.ts': config }),
      ...over,
    })

  test('worker target, new dir: the config edit and a minimal worker with no account id', () => {
    const plan = target({ name: 'My_Api' })
    expect(plan.actions.map((a) => `${a.kind} ${a.path}`)).toEqual([
      'edit kit.config.ts',
      'write apps/api/package.json',
      'write apps/api/src/index.ts',
      'write apps/api/tsconfig.json',
      'write apps/api/wrangler.jsonc',
    ])
    const content = (p: string) => (plan.actions.find((a) => a.path === p) as { content: string }).content
    const wrangler = JSON.parse(stripJsonc(content('apps/api/wrangler.jsonc')))
    expect(wrangler).toEqual({
      $schema: 'node_modules/wrangler/config-schema.json',
      name: 'my-api',
      main: 'src/index.ts',
      compatibility_date: '2026-01-02',
    })
    expect(JSON.parse(content('apps/api/package.json')).name).toBe('my-api')
    expect(JSON.parse(content('apps/api/tsconfig.json')).include).toEqual(['src/**/*.ts'])
    expect(content('apps/api/src/index.ts')).toContain('export default {')
    expect(content('kit.config.ts')).toContain("    My_Api: { kind: 'worker', dir: 'apps/api' },\n")
  })

  test('existing dir: only the config edit; other kinds get an empty dir', () => {
    expect(target({ exists: () => true }).actions.map((a) => a.path)).toEqual(['kit.config.ts'])
    expect(target({ kind: 'docker', dir: 'services/x' }).actions.map((a) => `${a.kind} ${a.path}`)).toEqual([
      'edit kit.config.ts',
      'write services/x/.gitkeep',
    ])
  })

  test('unsafe config: no actions, the snippet; an existing target is a usage error', () => {
    const plan = target({ read: reader({ 'kit.config.ts': 'export default make()\n' }) })
    expect(plan.actions).toEqual([])
    expect(plan.manual?.snippet).toBe("api: { kind: 'worker', dir: 'apps/api' },")
    expect(usage(() => target({ name: 'web' }))).toBe(2)
  })
})
