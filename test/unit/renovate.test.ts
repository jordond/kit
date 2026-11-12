import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { checkCiPin } from '../../src/commands/doctor'
import { bumpPin, KIT_PACKAGE, repinWorkflow } from '../../src/lib/kitref'

// renovate/default.json: the shared preset (`github>jordond/kit//renovate/default`). Renovate itself
// is not run here (no network in `bun test`): these pin the rules kit relies on and the ref format
// both sides read and write. The `renovate` job in .github/workflows/ci.yml runs Renovate's
// renovate-config-validator on the preset and the template configs.
const KIT = resolve(import.meta.dir, '../..')

interface Rule {
  description?: string
  matchManagers?: string[]
  matchPackageNames?: string[]
  groupName?: string
  rangeStrategy?: string
  pinDigests?: boolean
}
const preset = JSON.parse(readFileSync(join(KIT, 'renovate/default.json'), 'utf8')) as {
  $schema?: string
  description?: string
  packageRules: Rule[]
}
const rulesFor = (manager: string, name: string) =>
  preset.packageRules.filter((r) => r.matchManagers?.includes(manager) && r.matchPackageNames?.includes(name))

describe('renovate/default.json', () => {
  test('is a preset: a schema, a description and package rules only', () => {
    expect(preset.$schema).toBe('https://docs.renovatebot.com/renovate-schema.json')
    expect(preset.description).toContain('github>jordond/kit//renovate/default')
    expect(Object.keys(preset).sort()).toEqual(['$schema', 'description', 'packageRules'])
    for (const rule of preset.packageRules) {
      expect(rule.description).toBeTruthy()
      expect(rule.matchManagers?.length).toBeGreaterThan(0)
      expect(rule.matchPackageNames?.length).toBeGreaterThan(0)
    }
  })

  test('the npm pin and the workflow refs share one group, so they move in one PR', () => {
    const npm = rulesFor('npm', KIT_PACKAGE).map((r) => r.groupName)
    const actions = rulesFor('github-actions', 'jordond/kit').map((r) => r.groupName)
    expect(npm.filter(Boolean)).toEqual(['kit'])
    expect(actions.filter(Boolean)).toEqual(['kit'])
  })

  test('the package.json range always moves, as `kit upgrade` moves it', () => {
    expect(rulesFor('npm', KIT_PACKAGE).some((r) => r.rangeStrategy === 'bump')).toBe(true)
    // What "bump" writes for ^0.6.0 → 0.6.1 is what bumpPin writes.
    expect(bumpPin(`{ "devDependencies": { "${KIT_PACKAGE}": "^0.6.0" } }`, '0.6.1')?.to).toBe('^0.6.1')
  })

  test('workflow refs are pinned to a digest', () => {
    expect(rulesFor('github-actions', 'jordond/kit').some((r) => r.pinDigests === true)).toBe(true)
  })

  test('a digest-pinned ref with a version comment, as Renovate writes it, is what kit reads and rewrites', () => {
    const line = (sha: string, v: string) =>
      `      - uses: jordond/kit/.github/actions/setup@${sha} # v${v}\n` +
      `    uses: jordond/kit/.github/workflows/mobile-distribute.yml@${sha} # v${v}\n`
    const renovated = line('b'.repeat(40), '0.7.0')
    expect(checkCiPin([{ file: 'ci.yml', text: renovated }], '^0.7.0', true).status).toBe('ok')
    // Only one of the two moved: the state `kit doctor --ci` exists to catch.
    expect(checkCiPin([{ file: 'ci.yml', text: renovated }], '^0.6.0', true).status).toBe('fail')
    expect(repinWorkflow(line('a'.repeat(40), '0.6.0'), '0.7.0', 'b'.repeat(40))).toEqual({
      text: renovated,
      count: 2,
    })
  })

  test('CI validates the preset and both templates with a pinned Renovate', () => {
    const ci = readFileSync(join(KIT, '.github/workflows/ci.yml'), 'utf8')
    const job = ci.slice(ci.indexOf('\n  renovate:'))
    expect(job).toMatch(/renovate@\d+\.\d+\.\d+ -- renovate-config-validator --strict/)
    for (const file of [
      'renovate/default.json',
      'templates/gradle/renovate.json',
      'templates/toolchain/renovate.json',
    ])
      expect(job).toContain(file)
    // Actions stay pinned to a commit with a version comment, like the rest of the workflow.
    for (const uses of job.match(/uses: .*/g) ?? []) expect(uses).toMatch(/@[0-9a-f]{40} # v\d+/)
  })

  test('stays out of the npm tarball: Renovate reads it from the GitHub repo', () => {
    expect(pkg.files.some((f) => f === 'renovate' || f.startsWith('renovate/'))).toBe(false)
  })
})
