import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The reusable mobile-qa workflow: parses, takes the documented inputs, pins every action by SHA. It cannot run here. */

const FILE = join(resolve(import.meta.dir, '../..'), '.github/workflows/mobile-qa.yml')
const text = readFileSync(FILE, 'utf8')
type Step = { uses?: string; run?: string; name?: string; if?: string }
const doc = Bun.YAML.parse(text) as {
  on: { workflow_call: { inputs: Record<string, { type: string; default?: unknown }> } }
  jobs: Record<string, { 'runs-on': string; steps: Step[]; env?: Record<string, string> }>
}

describe('mobile-qa.yml', () => {
  test('is a workflow_call with the documented inputs, all optional', () => {
    const inputs = doc.on.workflow_call.inputs
    expect(Object.keys(inputs).sort()).toEqual(
      [
        'android-api',
        'android-device',
        'android-runner',
        'artifact-name',
        'bun-version',
        'emulator-args',
        'ios-device',
        'ios-runner',
        'java-version',
        'maestro-version',
        'platform',
        'suite',
        'timeout-minutes',
      ].sort(),
    )
    expect(inputs.platform?.default).toBe('both')
    expect(inputs['android-api']?.type).toBe('string')
  })

  test('one job per platform, and each uploads the Maestro output whatever the result', () => {
    expect(Object.keys(doc.jobs)).toEqual(['validate', 'ios', 'android'])
    for (const job of ['ios', 'android']) {
      const upload = doc.jobs[job]!.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))
      expect(upload?.if).toBe('always()')
    }
  })

  test('android: KVM, a Play image, the emulator args, and kit does the boot', () => {
    const android = doc.jobs.android!
    const runs = android.steps.map((s) => s.run ?? '').join('\n')
    expect(runs).toContain('99-kvm4all.rules')
    expect(runs).toContain('google_apis_playstore')
    expect(runs).not.toContain('adb root')
    expect(runs).toContain('kit device boot android --device "$AVD_NAME"')
    expect(android.env?.KIT_EMULATOR_ARGS).toBe('${{ inputs.emulator-args }}')
    expect(android['runs-on']).toBe('${{ inputs.android-runner }}')
  })

  test('ios: a macOS runner and kit boots the simulator', () => {
    const ios = doc.jobs.ios!
    expect(ios['runs-on']).toBe('${{ inputs.ios-runner }}')
    expect(doc.on.workflow_call.inputs['ios-runner']?.default).toBe('macos-latest')
    expect(ios.steps.map((s) => s.run ?? '').join('\n')).toContain('kit "${boot[@]}"')
  })

  test('every action is pinned by a full SHA, and no input is interpolated into a script', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!)
    expect(uses.length).toBeGreaterThan(8)
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
    for (const job of Object.values(doc.jobs)) {
      for (const step of job.steps) expect(step.run ?? '').not.toContain('${{')
    }
  })

  test('actionlint is clean when it is installed', async () => {
    const bin = Bun.which('actionlint')
    if (bin === null) {
      console.warn('actionlint not installed: skipped')
      return
    }
    const proc = Bun.spawn([bin, FILE], { stdout: 'pipe', stderr: 'pipe' })
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
    expect({ code: await proc.exited, out }).toEqual({ code: 0, out: '' })
  })
})
