import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { installDir } from '../../config/load'
import type { KitConfig } from '../../config/schema'
import { AGENTS_FILE, agentGuide, agentPlan, applyAgents, currentBlock, guideFacts } from '../agents'
import { findChrome } from '../chrome'
import { compareVersions, kitCopyAt, pathKit } from '../kit-copy'
import { latestVersion } from '../kitref'
import { androidSdkDir, findSdkTool, hostAbi, installedSystemImages, SDK_TOOLS } from '../devices'
import { preferredSystemImage, systemImagePackage } from '../devices/pick'
import { findMaestro } from '../maestro/bin'
import { detectPackageManager, installRoot, pmExec } from '../pm'
import { runQuiet } from '../proc'
import { globalInstaller, newerThan, readUpdateState, updateCheckOff } from '../self-update'
import { onGitHubActions, releaseSecrets, renameHints } from '../release/creds'
import { androidVersionDrift, iosVersionDrift } from '../release/version'
import { parseToml, readToml } from '../toml'
import {
  type Check,
  catalogPath,
  checkAdb,
  checkAndroidSdk,
  checkAndroidVersion,
  checkBun,
  checkCatalogKeys,
  checkChrome,
  checkCiPin,
  checkEmulator,
  checkEnvFile,
  checkIosVersion,
  checkJava,
  checkKtlint,
  checkAgentGuide,
  checkLefthook,
  checkMaestro,
  checkMaestroJava,
  checkMise,
  checkPathKit,
  checkReleaseSecrets,
  checkRuby,
  checkSimulator,
  checkToolchain,
  checkUnreadable,
  checkWranglerLogin,
  checkXcode,
  LEFTHOOK_FILES,
  type Probe,
  parseJavaVersion,
  parseKtlintVersion,
  parseMiseTools,
} from './checks'
import { androidVersionFix, ciPinFix, iosVersionFix, pinVersion } from './fixes'

/**
 * What `kit doctor` probes in a repo: one entry per check, in report order. An entry reads the
 * machine and the repo and hands the result to its pure check (./checks.ts).
 */

/** `run` returns undefined for a check that does not apply to the repo. */
export interface Entry {
  id: string
  run: () => Check | undefined | Promise<Check | undefined>
}

/**
 * `<pm> install` for a worker whose wrangler is missing, resolved like the probe: the package
 * manager of the nearest lockfile walking up from the worker dir, run where that install lives.
 */
export function workerInstall(root: string, workerDir: string): { cmd: string[]; cwd: string } {
  const dir = join(root, workerDir)
  return {
    cmd: [detectPackageManager(dir, root), 'install'],
    cwd: relative(root, installRoot(dir, root)) || '.',
  }
}

/**
 * Whether `bin` is installed for `dir` (repo-relative): in its node_modules or in any ancestor's up
 * to the repo root, as Node resolves it. Every place `workerInstall` can install into is covered.
 */
export function hasBin(root: string, dir: string, bin: string): boolean {
  const stop = resolve(root)
  for (let d = resolve(root, dir); ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules/.bin', bin))) return true
    if (d === stop || dirname(d) === d) return false
  }
}

/**
 * The checks for `root`. Probes run once per pass and are shared between checks; `refresh` drops
 * them, so entries run again after a fix see the machine as it is now.
 */
export function doctorEntries(
  root: string,
  config: KitConfig | undefined,
  opts: { strictCi?: boolean } = {},
): { entries: Entry[]; refresh: () => void } {
  const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined)
  let probes = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!probes.has(key)) probes.set(key, fn())
    return probes.get(key) as Promise<T>
  }
  const probe = (cmd: string[]): Promise<Probe> =>
    once(cmd.join(' '), async () => (Bun.which(cmd[0]!) ? await runQuiet(cmd, { cwd: root }) : undefined))

  const targets = Object.values(config?.targets ?? {})
  // The Kotlin toolchain provisions its own JDK and Android SDK: neither is required for it.
  const gradle = !!config?.gradle || targets.some((t) => t.kind === 'gradle')
  const toolchainRoot = config?.toolchain?.root
  const wrapperPath = toolchainRoot === undefined ? undefined : join(root, toolchainRoot, 'kotlin')
  const ios = !!config?.release?.ios
  const fastlane = ios || !!config?.release?.android
  // `kit app` and `kit device` drive these apps; adb, an emulator and a simulator are theirs alone.
  const iosDevice = ios || !!config?.app?.ios
  const androidDevice = !!config?.release?.android || !!config?.app?.android
  const worker = targets.find((t) => t.kind === 'worker')
  // kotlin targets lint and format with ktlint unless both verbs are overridden or off.
  const ktlintUsed = targets.some(
    (t) => t.kind === 'kotlin' && (t.lint === undefined || t.format === undefined),
  )
  const lefthookFile = LEFTHOOK_FILES.find((f) => existsSync(join(root, f)))
  const miseFile = ['mise.toml', '.mise.toml'].find((f) => existsSync(join(root, f)))
  // The kit pin: `.kit/package.json` when the repo installs kit there, else the root package.json.
  const pkgFile = installDir(root) === '.' ? 'package.json' : `${installDir(root)}/package.json`
  const catalogFile = catalogPath(config)

  const java = () => probe(['java', '-version'])
  const ruby = () => probe(['ruby', '--version'])
  const ktlint = async () => (ktlintUsed ? await probe(['ktlint', '--version']) : undefined)
  const wrangler = async (): Promise<Probe | 'skip'> => {
    if (!worker) return 'skip'
    const dir = join(root, worker.dir)
    // Never let `bun x` download wrangler just to ask who is logged in.
    if (!hasBin(root, worker.dir, 'wrangler')) return undefined
    return await runQuiet(pmExec(detectPackageManager(dir, root), 'wrangler', 'whoami'), {
      cwd: dir,
    }).catch(() => undefined)
  }
  const mise = async (): Promise<Check> => {
    if (!miseFile) return checkMise(undefined, {})
    let tools: Record<string, string>
    try {
      tools = parseMiseTools(readToml(join(root, miseFile)).tools)
    } catch (e) {
      return checkUnreadable('mise', 'mise.toml versions', miseFile, e)
    }
    const [j, r] = await Promise.all([java(), ruby()])
    const detected: Record<string, string | undefined> = {
      bun: Bun.version,
      java: j?.code === 0 ? parseJavaVersion(j.output) : undefined,
      ruby: r?.output.match(/ruby (\d[\w.]*)/)?.[1],
    }
    if (tools.ktlint) {
      const k = await ktlint()
      detected.ktlint = k?.code === 0 ? parseKtlintVersion(k.output) : undefined
    }
    if (tools.node) detected.node = (await probe(['node', '--version']))?.output.trim().replace(/^v/, '')
    return checkMise(tools, detected, !!Bun.which('mise'))
  }
  const lefthook = async (): Promise<Check> => {
    let hook: string | undefined
    if (lefthookFile) {
      // --git-path follows worktrees and core.hooksPath.
      const r = await probe(['git', 'rev-parse', '--git-path', 'hooks/pre-commit'])
      const hookPath = r?.code === 0 ? resolve(root, r.output.trim()) : undefined
      if (hookPath && existsSync(hookPath)) hook = readFileSync(hookPath, 'utf8')
    }
    return checkLefthook(lefthookFile, !!Bun.which('lefthook'), hook, onGitHubActions())
  }
  const toolchain = (): Check => {
    const wrapper = wrapperPath && existsSync(wrapperPath) ? readFileSync(wrapperPath, 'utf8') : undefined
    let executable = false
    if (wrapperPath && wrapper !== undefined) {
      try {
        accessSync(wrapperPath, constants.X_OK)
        executable = true
      } catch {}
    }
    return checkToolchain(toolchainRoot, wrapper, executable)
  }
  const kitPin = (): { pin?: string; unreadable?: Check } => {
    const text = read(pkgFile)
    try {
      const pkg = (text ? JSON.parse(text) : {}) as {
        devDependencies?: Record<string, string>
        dependencies?: Record<string, string>
      }
      return { pin: pkg.devDependencies?.['@jordond/kit'] ?? pkg.dependencies?.['@jordond/kit'] }
    } catch (e) {
      return { unreadable: checkUnreadable('package-json', 'package.json', pkgFile, e) }
    }
  }
  const ciPin = (): Check => {
    const wfDir = join(root, '.github/workflows')
    const workflows = existsSync(wfDir)
      ? readdirSync(wfDir)
          .filter((f) => /\.ya?ml$/.test(f))
          .map((f) => ({ file: f, text: readFileSync(join(wfDir, f), 'utf8') }))
      : []
    const { pin } = kitPin()
    const version = pinVersion(pin)
    return checkCiPin(workflows, pin, opts.strictCi === true, () =>
      version ? ciPinFix(root, version) : undefined,
    )
  }
  const catalog = (): Check => {
    try {
      const text = catalogFile ? read(catalogFile) : undefined
      return checkCatalogKeys(catalogFile, text === undefined ? undefined : parseToml(text))
    } catch (e) {
      return checkUnreadable('catalog', 'catalog keys', catalogFile ?? '', e)
    }
  }

  const entries: Entry[] = [
    { id: 'bun', run: () => checkBun(Bun.version) },
    {
      id: 'kit',
      run: async () => {
        const own = kitCopyAt(import.meta.dir)
        const onPath = pathKit()
        if (!own || !onPath) return undefined
        const same = realpathSync(onPath.dir) === realpathSync(own.dir)
        // A release newer than the global kit: asked of npm now, else what the last lookup found.
        const latest =
          updateCheckOff() || !globalInstaller(onPath.dir)
            ? undefined
            : newerThan(onPath.version, (await latestVersion(3_000)) ?? readUpdateState().latest)
        if (same && !latest) return undefined
        const older = !same && compareVersions(onPath.version, own.version) < 0
        return checkPathKit(onPath.version, own.version, older, latest)
      },
    },
    { id: 'java', run: async () => checkJava(await java(), gradle) },
    { id: 'ruby', run: async () => checkRuby(await ruby(), fastlane) },
    {
      id: 'xcode',
      run: async () =>
        checkXcode(
          process.platform === 'darwin' ? await probe(['xcodebuild', '-version']) : undefined,
          ios,
          process.platform,
        ),
    },
    {
      id: 'android-sdk',
      run: () =>
        checkAndroidSdk(
          process.env,
          config?.gradle ? read(join(config.gradle.root, 'local.properties')) : undefined,
          existsSync,
          gradle,
        ),
    },
    {
      id: 'adb',
      run: () =>
        config && androidDevice
          ? checkAdb(findSdkTool({ root, config }, 'adb', ...SDK_TOOLS.adb))
          : undefined,
    },
    {
      id: 'emulator',
      run: () => {
        if (!config || !androidDevice) return undefined
        const env = { root, config }
        const image = preferredSystemImage(installedSystemImages(androidSdkDir(root, config)), hostAbi())
        return checkEmulator({
          emulator: !!findSdkTool(env, 'emulator', ...SDK_TOOLS.emulator),
          avdmanager: !!findSdkTool(env, 'avdmanager', ...SDK_TOOLS.avdmanager),
          image: image && systemImagePackage(image),
          abi: hostAbi(),
        })
      },
    },
    {
      id: 'simulator',
      run: async () =>
        iosDevice
          ? checkSimulator(
              process.platform === 'darwin'
                ? await probe(['xcrun', 'simctl', 'list', 'runtimes', '-j'])
                : undefined,
              process.platform,
            )
          : undefined,
    },
    {
      id: 'maestro',
      run: async () => {
        if (!config?.maestro) return undefined
        const bin = findMaestro()
        // The installer puts maestro in ~/.maestro/bin, which a non-interactive shell may not have on PATH.
        return checkMaestro(
          bin ? await runQuiet([bin, '--version'], { cwd: root }).catch(() => undefined) : undefined,
          config.maestro.version,
        )
      },
    },
    {
      id: 'maestro-java',
      run: async () =>
        config?.maestro ? checkMaestroJava(await java(), checkJava(await java(), gradle)) : undefined,
    },
    {
      id: 'chrome',
      run: async () => {
        if (!config?.shots) return undefined
        const bin = findChrome(process.env)
        return checkChrome(
          bin ? await runQuiet([bin, '--version'], { cwd: root }).catch(() => undefined) : undefined,
        )
      },
    },
    { id: 'toolchain', run: () => (toolchainRoot !== undefined ? toolchain() : undefined) },
    {
      id: 'wrangler',
      run: async () =>
        checkWranglerLogin(await wrangler(), worker ? workerInstall(root, worker.dir) : undefined),
    },
    { id: 'ktlint', run: async () => (ktlintUsed ? checkKtlint(await ktlint(), true) : undefined) },
    { id: 'mise', run: mise },
    { id: 'lefthook', run: lefthook },
    { id: 'env', run: () => checkEnvFile(read('.env.example'), read('.env')) },
    {
      id: 'agents',
      run: () =>
        config
          ? checkAgentGuide(currentBlock(read(AGENTS_FILE)), agentGuide(config, guideFacts(root, config)), {
              description: 'kit agents sync',
              action: {
                edit: () => {
                  applyAgents(root, agentPlan(root, config))
                  return undefined
                },
              },
            })
          : undefined,
    },
    {
      id: 'ios-version',
      run: () =>
        config?.release?.ios?.xcconfig
          ? checkIosVersion(
              () => iosVersionDrift(root, config),
              (d) => iosVersionFix(root, d),
            )
          : undefined,
    },
    {
      id: 'android-version',
      run: () =>
        config?.toolchain && config.release?.android
          ? checkAndroidVersion(
              () => androidVersionDrift(root, config),
              (d) => androidVersionFix(root, d),
            )
          : undefined,
    },
    {
      id: 'release-secrets',
      run: () =>
        checkReleaseSecrets(releaseSecrets(config), process.env, onGitHubActions(), (m) =>
          renameHints(m, (old) => !!process.env[old]),
        ),
    },
    { id: 'ci-pin', run: ciPin },
    { id: 'catalog', run: catalog },
    { id: 'package-json', run: () => kitPin().unreadable },
  ]
  return {
    entries,
    refresh: () => {
      probes = new Map()
    },
  }
}
