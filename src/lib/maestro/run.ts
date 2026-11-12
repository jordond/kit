import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { runApp } from '../app/install'
import {
  adb,
  bootDevice,
  type DeviceEnv,
  type DeviceTarget,
  listDevices,
  platformOf,
  resolveDevice,
} from '../devices'
import { androidStatusBarCommands, iosStatusBarCommands, runStatusBarCommands } from '../devices/statusbar'
import { loadFixture as defaultLoadFixture, type FixtureResult } from '../fixtures'
import { runToStderr } from '../proc'
import { findMaestro, maestroBin, maestroEnv } from './bin'
import { outputDir, requireMaestro, type Suite } from './suites'

/** Stands in for the device in a dry-run plan when none is running (a dry run boots nothing). */
const DEVICE_PLACEHOLDER = '<device>'

export interface FlowCommandOptions {
  /** The dir holding `config.yaml` and the flows. */
  dir: string
  device: string
  tags: readonly string[]
  outputDir: string
  env?: Readonly<Record<string, string>>
  /** Write a JUnit report here. */
  junit?: string
}

/**
 * One `maestro test` argv. `--device` is always passed: without it Maestro blocks on a stdin picker.
 * `--flatten-debug-output` is never passed: it conflicts with `--test-output-dir`.
 */
export function flowCommand(bin: string, o: FlowCommandOptions): string[] {
  return [
    bin,
    '--device',
    o.device,
    'test',
    o.dir,
    '--include-tags',
    o.tags.join(','),
    '--test-output-dir',
    o.outputDir,
    ...Object.entries(o.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...(o.junit === undefined ? [] : ['--format', 'JUNIT', '--output', o.junit]),
  ]
}

/** Report paths for `count` stages: `qa.xml`, then `qa-2.xml`, `qa-3.xml`, … */
export function junitPaths(path: string, count: number): string[] {
  const ext = extname(path)
  const stem = ext ? path.slice(0, -ext.length) : path
  return Array.from({ length: count }, (_, i) => (i === 0 ? path : `${stem}-${i + 1}${ext || '.xml'}`))
}

// ---- run dirs and screenshots -----------------------------------------------------------------

/** The run dirs (`yyyy-MM-dd_HHmmss`) Maestro has written under `dir`; none when it does not exist yet. */
export function listRunDirs(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** What a stage wrote: the dirs in `after` that `before` lacked. Not "the newest": a parallel run may be newer. */
export const newRunDirs = (before: readonly string[], after: readonly string[]): string[] =>
  after.filter((name) => !before.includes(name))

export interface Shot {
  name: string
  path: string
}

/** The `takeScreenshot` PNGs of each flow under the given run dirs, oldest run first. */
export function collectScreenshots(dir: string, runs: readonly string[]): Shot[] {
  const shots: Shot[] = []
  for (const run of runs) {
    const flows = readdirSync(join(dir, run), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const flow of flows) {
      const shotDir = join(dir, run, flow.name, 'takeScreenshot')
      if (!existsSync(shotDir)) continue
      for (const name of readdirSync(shotDir).sort()) {
        if (name.toLowerCase().endsWith('.png')) shots.push({ name, path: join(shotDir, name) })
      }
    }
  }
  return shots
}

/** Copy shots into `dest`: a shot replaces the file of the same name and leaves the rest. Returns the names. */
export function copyScreenshots(shots: readonly Shot[], dest: string): string[] {
  mkdirSync(dest, { recursive: true })
  for (const shot of shots) copyFileSync(shot.path, join(dest, shot.name))
  return [...new Set(shots.map((s) => s.name))]
}

// ---- the run ----------------------------------------------------------------------------------

export interface StageResult {
  tags: string[]
  ok: boolean
  code: number
  ms: number
  /** Repo-relative dir Maestro wrote the run dirs under. */
  outputDir: string
  /** Repo-relative paths of the screenshots this stage copied. */
  screenshots: string[]
  /** Why a stage whose flows passed still failed. */
  error?: string
}

export interface SuiteResult {
  suite: string
  target: DeviceTarget
  device: string
  ok: boolean
  stages: StageResult[]
  /** Repo-relative dir the screenshots went to. */
  screenshotsDir?: string
  fixture?: string
  junit?: string[]
}

export interface RunSuiteOptions {
  suite: Suite
  /** Simulator UDID or adb serial; default the running device, or boot one. */
  device?: string
  /** Install the newest existing build. */
  noBuild?: boolean
  /** A fixture name replaces the suite's; `false` loads none. */
  fixture?: string | false
  /** Repo-relative screenshots dir, used as is. Default `<suite.screenshots>/<target>`. */
  screenshotsDir?: string
  /** Base path for JUnit reports; one per stage. */
  junit?: string
  /** Injected in tests. */
  loadFixture?: (env: DeviceEnv, target: DeviceTarget, device: string, name: string) => Promise<FixtureResult>
}

export interface SuiteRun {
  result: SuiteResult
  /** Every command of the run, in order; all of it a dry run does. */
  plan: string[][]
}

/**
 * The device every step lands on: `--device`, a running one, else the one `maestro.devices.<target>`
 * names (booted), else kit's pick. A dry run boots nothing and shows a placeholder.
 */
async function suiteDevice(env: DeviceEnv, target: DeviceTarget, flag: string | undefined): Promise<string> {
  if (flag) return flag
  const named = env.config.maestro?.devices?.[target]
  const running = (await listDevices(env, target)).length > 0
  if (!running && env.flags.dryRun) return DEVICE_PLACEHOLDER
  if (!running && named) return await bootDevice(env, target, named)
  return await resolveDevice(env, target)
}

/** Build, install, pin the status bar, load the fixture, then run each stage; stops at the first failure. */
export async function runSuite(env: DeviceEnv, target: DeviceTarget, o: RunSuiteOptions): Promise<SuiteRun> {
  const m = requireMaestro(env.config)
  const dry = env.flags.dryRun
  const { suite } = o
  // Before the build: a missing Maestro should not cost a build first.
  const bin = dry ? (findMaestro() ?? 'maestro') : maestroBin(env.config)
  const fixture = o.fixture === false ? undefined : (o.fixture ?? suite.fixture)
  const shotsDir = suite.screenshots
    ? (o.screenshotsDir ?? join(suite.screenshots, target))
    : o.screenshotsDir
  const reports = o.junit ? junitPaths(o.junit, suite.stages.length) : undefined
  const out = outputDir(env.config, suite.name, target)
  const plan: string[][] = []

  // Everything that can fail without a device fails before one is booted or a build is paid for.
  if (fixture && !o.loadFixture) {
    const { fixtureConfig, requireFixtureDir } = await import('../fixtures/config')
    requireFixtureDir(fixtureConfig(env.root, env.config), fixture)
  }
  let device = await suiteDevice(env, target, o.device)
  const app = await runApp(env, target, { device, noBuild: o.noBuild, launch: false })
  plan.push(...app.plan)

  if (suite.statusBar) {
    const cmds =
      target === 'android'
        ? androidStatusBarCommands(adb(env), device, false)
        : iosStatusBarCommands(device, false)
    plan.push(...cmds)
    if (!dry) {
      env.log.step(`status bar: 9:41 on ${device}`)
      await runStatusBarCommands(cmds)
    }
  }

  if (fixture) {
    plan.push(['kit', 'fixture', 'load', target, fixture, '--device', device])
    if (!dry) {
      env.log.step(`fixture ${fixture}`)
      // `adb root` can bring an emulator back under another serial: the flows follow the fixture.
      device = (await (o.loadFixture ?? defaultLoadFixture)(env, target, device, fixture)).device
    }
  }

  const flowEnv = { PLATFORM: platformOf(target), ...suite.env }
  const result: SuiteResult = {
    suite: suite.name,
    target,
    device,
    ok: true,
    stages: [],
    ...(shotsDir ? { screenshotsDir: shotsDir } : {}),
    ...(fixture ? { fixture } : {}),
    ...(reports ? { junit: reports } : {}),
  }
  const absOut = resolve(env.root, out)
  for (const [i, tags] of suite.stages.entries()) {
    const cmd = flowCommand(bin, {
      dir: m.dir,
      device,
      tags,
      outputDir: out,
      env: flowEnv,
      junit: reports?.[i],
    })
    plan.push(cmd)
    if (dry) continue
    env.log.step(`maestro ${tags.join(',')}`)
    const before = listRunDirs(absOut)
    const started = performance.now()
    const code = await runToStderr(cmd, { cwd: env.root, env: maestroEnv(env.flags) })
    const stage: StageResult = {
      tags: [...tags],
      ok: code === 0,
      code,
      ms: Math.round(performance.now() - started),
      outputDir: out,
      screenshots: [],
    }
    result.stages.push(stage)
    if (code !== 0) break
    if (shotsDir) {
      const shots = collectScreenshots(absOut, newRunDirs(before, listRunDirs(absOut)))
      stage.screenshots = copyScreenshots(shots, resolve(env.root, shotsDir)).map((n) => join(shotsDir, n))
      if (!shots.length) {
        stage.ok = false
        stage.error = `${tags.join(',')} passed but took no screenshot`
        break
      }
    }
  }
  result.ok = result.stages.every((s) => s.ok)
  return { result, plan }
}

/** Why a run failed, one line: the failed stage's tags and exit code, or the missing screenshots. */
export function failureSummary(result: SuiteResult): string {
  const bad = result.stages.find((s) => !s.ok)
  if (!bad) return `${result.suite} failed on ${result.target}`
  return bad.error ?? `${bad.tags.join(',')} failed on ${result.target} (maestro exit ${bad.code})`
}
