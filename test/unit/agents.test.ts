import { describe, expect, test } from 'bun:test'
import { configSchema } from '../../src/config/schema'
import { checkAgentGuide } from '../../src/lib/doctor/checks'
import {
  agentGuide,
  BLOCK_END,
  BLOCK_START,
  currentBlock,
  hasAgentHook,
  hookCommand,
  hookVerdict,
  planAgents,
  withAgentBlock,
  withAgentHook,
  withClaudeImport,
} from '../../src/lib/agents'

const toolchain = configSchema.parse({
  name: 'x',
  toolchain: { root: '.' },
  targets: { app: { kind: 'kotlin', dir: '.', dev: './kotlin run -m desktop' } },
})
const gradle = configSchema.parse({
  name: 'x',
  gradle: { root: 'apps/client' },
  targets: { client: { kind: 'gradle', dir: 'apps/client' }, api: { kind: 'worker', dir: 'apps/api' } },
})
const js = configSchema.parse({ name: 'x', targets: { api: { kind: 'worker', dir: 'apps/api' } } })

describe('agentGuide', () => {
  test('toolchain: the wrapper, the passthrough, modules and the local kit', () => {
    const guide = agentGuide(toolchain, {
      modules: ['core', 'android'],
      localKit: './.kit/node_modules/.bin/kit',
    })
    expect(guide.startsWith(BLOCK_START)).toBe(true)
    expect(guide.endsWith(BLOCK_END)).toBe(true)
    expect(guide).toContain('never with `./kotlin` directly')
    expect(guide).toContain('`kit build -m <module> -p <platform>`')
    expect(guide).toContain('`kit kotlin <args>`')
    expect(guide).toContain('Modules: `core`, `android`.')
    expect(guide).toContain('`./.kit/node_modules/.bin/kit`')
  })
  test('gradle names gradlew; a JS-only repo has no module rows or passthrough', () => {
    expect(agentGuide(gradle)).toContain('`kit gradle <args>`')
    expect(agentGuide(gradle)).toContain('`client` (gradle), `api` (worker)')
    const plain = agentGuide(js)
    expect(plain).not.toContain('-m <module>')
    expect(plain).not.toContain('passes through')
    expect(plain).not.toContain('directly')
  })
})

describe('AGENTS.md and CLAUDE.md', () => {
  const block = agentGuide(js)
  test('a missing file is the block; an existing one gains it after its own text', () => {
    expect(withAgentBlock(undefined, block)).toBe(`${block}\n`)
    expect(withAgentBlock('# Mine\n\nnotes\n\n\n', block)).toBe(`# Mine\n\nnotes\n\n${block}\n`)
  })
  test('only the block is replaced, and a current one is left alone', () => {
    const file = `# Mine\n\n${BLOCK_START}\nold $& text\n${BLOCK_END}\n\nafter\n`
    expect(withAgentBlock(file, block)).toBe(`# Mine\n\n${block}\n\nafter\n`)
    expect(withAgentBlock(`# Mine\n\n${block}\n`, block)).toBeUndefined()
    expect(currentBlock(file)).toBe(`${BLOCK_START}\nold $& text\n${BLOCK_END}`)
    expect(currentBlock('# Mine\n')).toBeUndefined()
  })
  test('CLAUDE.md imports AGENTS.md once', () => {
    expect(withClaudeImport(undefined)).toBe('@AGENTS.md\n')
    expect(withClaudeImport('# Rules\n')).toBe('# Rules\n\n@AGENTS.md\n')
    expect(withClaudeImport('See @AGENTS.md\n')).toBeUndefined()
  })
  test('planAgents: writes, edits and skips; the hook only when asked', () => {
    const files: Record<string, string> = { 'CLAUDE.md': '@AGENTS.md\n' }
    const plan = planAgents({ read: (p) => files[p], block })
    expect(plan.map((a) => `${a.kind} ${a.path}`)).toEqual(['write AGENTS.md', 'skip CLAUDE.md'])
    const hooked = planAgents({ read: (p) => files[p], block, hook: 'kit agents hook' })
    expect(hooked.map((a) => `${a.kind} ${a.path}`)).toContain('write .claude/settings.json')
    const broken = planAgents({ read: () => '[', block, hook: 'kit agents hook' })
    expect(broken.find((a) => a.path === '.claude/settings.json')!.kind).toBe('skip')
  })
  test('doctor: no block is an info line; a stale one warns with the fix; a current one passes', () => {
    const fix = { description: 'kit agents sync', action: { edit: () => undefined } }
    expect(checkAgentGuide(block, block, fix).status).toBe('ok')
    // Opt-in: a repo without the block is told about it, not warned, and gets no fix.
    const absent = checkAgentGuide(undefined, block, fix)
    expect(absent.status).toBe('skip')
    expect(absent.fix).toBeUndefined()
    expect(absent.detail).toContain('kit agents sync')
    expect(checkAgentGuide('old', block, fix)).toMatchObject({ status: 'warn', fix })
  })
})

describe('the Claude Code hook', () => {
  test('hookCommand: kit on PATH, or the repo copy in .kit/', () => {
    expect(hookCommand('.')).toBe('kit agents hook')
    expect(hookCommand('.kit')).toBe('"$CLAUDE_PROJECT_DIR"/.kit/node_modules/.bin/kit agents hook')
  })
  test('withAgentHook: adds to the settings it finds, updates its own entry, keeps the rest', () => {
    const fresh = JSON.parse(withAgentHook(undefined, 'kit agents hook') as string)
    expect(fresh.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'kit agents hook' }] },
    ])
    const existing = JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'other' }] }], Stop: [] },
    })
    const merged = JSON.parse(withAgentHook(existing, 'kit agents hook') as string)
    expect(merged.permissions).toEqual({ allow: ['Bash(ls)'] })
    expect(merged.hooks.Stop).toEqual([])
    expect(merged.hooks.PreToolUse).toHaveLength(2)
    const text = JSON.stringify(merged)
    expect(hasAgentHook(text)).toBe(true)
    expect(hasAgentHook(existing)).toBe(false)
    expect(withAgentHook(text, 'kit agents hook')).toBeUndefined()
    const moved = JSON.parse(withAgentHook(text, hookCommand('.kit')) as string)
    expect(moved.hooks.PreToolUse).toHaveLength(2)
    expect(moved.hooks.PreToolUse[1].hooks[0].command).toBe(hookCommand('.kit'))
    expect(withAgentHook('[]', 'kit agents hook')).toBe('invalid')
    expect(withAgentHook('{', 'kit agents hook')).toBe('invalid')
  })

  test.each([
    ['./kotlin build -m core -p jvm', 'kit build -m core -p jvm'],
    [
      'cd app && FOO=1 ./kotlin test --include-module=core --platform jvm --include-classes A',
      'kit test -m core -p jvm -- --include-classes A',
    ],
    ['/repo/kotlin build', 'kit build'],
  ])('toolchain refuses %s', (command, kit) => {
    expect(hookVerdict(command, toolchain)).toContain(`Run \`${kit}\` instead`)
  })
  test.each([
    ['./gradlew build', 'kit build'],
    ['./gradlew :core:test :libs:data:test --info', 'kit test -m :core -m :libs:data -- --info'],
    ['./gradlew spotlessApply', 'kit format'],
  ])('gradle refuses %s', (command, kit) => {
    expect(hookVerdict(command, gradle)).toContain(`Run \`${kit}\` instead`)
  })
  test.each([
    ['./kotlin run -m desktop', toolchain],
    ['kit kotlin build -m core', toolchain],
    ['kotlin build', toolchain],
    ['./gradlew build', toolchain],
    ['./kotlin build', gradle],
    ['./gradlew :app:assembleDebug', gradle],
    ['./gradlew build :app:installDebug', gradle],
    ['./gradlew build test', gradle],
    ['./gradlew :core:spotlessCheck', gradle],
    ['./gradlew', gradle],
    ['git status && ls', gradle],
    ['./kotlin build', js],
  ])('%s passes', (command, config) => {
    expect(hookVerdict(command, config)).toBeUndefined()
  })
})
