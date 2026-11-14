import { randomInt } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { KitConfig } from '../../config/schema'
import { ExitCode, KitError } from '../errors'
import { type ModuleKind, releaseAndroidModule } from '../module'
import { runPiped } from '../proc'
import { redact, registerSecret, secretFile } from '../secrets'
import { dotenvValues } from './setup'
import { keystoreProperties, requireWrapper, WRAPPER } from '../toolchain'

/**
 * `kit release setup android`: create the Android upload keystore and store it under the canonical
 * secret names (PLAN §9.5). One password for store and key, as `kit.release` and the toolchain
 * release build expect. The password reaches the generator through a 0600 properties file
 * (toolchain) or the child's env (keytool), never argv.
 */

export const DEFAULT_ALIAS = 'key0'
export const KEYSTORE_SECRETS = [
  'ANDROID_KEYSTORE_BASE64',
  'ANDROID_KEYSTORE_ALIAS',
  'ANDROID_KEYSTORE_PASSWORD',
] as const

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Letters and digits only: safe bare in .env, a properties file and a shell. */
export function generatePassword(length = 32): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/** `~/.keystores/<name>.keystore`: outside the repo, so it cannot be committed. */
export function defaultKeystorePath(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'release'
  return join(homedir(), '.keystores', `${slug}.keystore`)
}

/** A DN value with its special characters escaped (RFC 2253). */
export const dnFor = (name: string): string => `CN=${name.replace(/([,+"\\<>;=])/g, '\\$1')}`

const PASSWORD_ENV = 'KIT_KEYSTORE_PASSWORD'

export function keytoolArgs(o: { file: string; alias: string; dn: string }): string[] {
  return [
    'keytool',
    '-genkeypair',
    '-keystore',
    o.file,
    '-storetype',
    'PKCS12',
    '-alias',
    o.alias,
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '10000',
    '-dname',
    o.dn,
    `-storepass:env`,
    PASSWORD_ENV,
  ]
}

export type Generator = 'toolchain' | 'keytool'

export const generatorFor = (kind: ModuleKind | undefined): Generator =>
  kind === 'toolchain' ? 'toolchain' : 'keytool'

export interface GenerateOptions {
  generator: Generator
  file: string
  alias: string
  password: string
  dn: string
}

/** Create the keystore at `file` (0600). The caller has checked it does not exist. */
export async function generateKeystore(root: string, config: KitConfig, o: GenerateOptions): Promise<void> {
  registerSecret(o.password)
  mkdirSync(dirname(o.file), { recursive: true, mode: 0o700 })
  let r: { code: number; stdout: string; stderr: string }
  let what: string
  if (o.generator === 'toolchain') {
    const cwd = requireWrapper(root, config)
    const props = secretFile('generate-keystore.properties', keystoreProperties(o.file, o.alias, o.password))
    what = `${WRAPPER} tool generate-keystore`
    r = await runPiped([WRAPPER, 'tool', 'generate-keystore', '--properties-file', props, '--dn', o.dn], {
      cwd,
    })
  } else {
    if (!Bun.which('keytool')) {
      throw new KitError('keytool not found', 'Install a JDK (keytool ships with it)', ExitCode.config)
    }
    what = 'keytool'
    r = await runPiped(keytoolArgs(o), { cwd: root, env: { [PASSWORD_ENV]: o.password } })
  }
  if (r.code !== 0 || !existsSync(o.file)) {
    const output = redact(`${r.stderr}${r.stdout}`.trim())
    throw new KitError(
      `${what} ${r.code !== 0 ? `failed (exit ${r.code})` : `wrote no keystore at ${o.file}`}`,
      output || undefined,
    )
  }
  chmodSync(o.file, 0o600)
}

/** Which of the keystore secrets `.env` already holds a value for. */
export function existingKeystoreSecrets(root: string): string[] {
  const values = dotenvValues(root)
  return KEYSTORE_SECRETS.filter((k) => k in values)
}

export function keystoreSecretValues(file: string, alias: string, password: string): Record<string, string> {
  return {
    ANDROID_KEYSTORE_BASE64: readFileSync(file).toString('base64'),
    ANDROID_KEYSTORE_ALIAS: alias,
    ANDROID_KEYSTORE_PASSWORD: password,
  }
}

const RELEASE_PLUGIN = /kit[.-]release|io\.github\.jordond\.kit\.release/

/**
 * What the build still needs before a release signs with this keystore; empty when nothing.
 * - Gradle: the app module must apply `io.github.jordond.kit.release`, which reads ANDROID_KEYSTORE_*.
 * - Kotlin toolchain: nothing. kit writes `settings.android.signing` into module.yaml for the build.
 */
export function buildConfigNotes(root: string, config: KitConfig, kind: ModuleKind | undefined): string[] {
  if (kind !== 'gradle') return []
  const module = releaseAndroidModule(root, config, kind)
  if (!module) return ['Set release.android.module in kit.config.ts to the Android app module']
  const build = ['build.gradle.kts', 'build.gradle']
    .map((f) => join(root, module.dir, f))
    .find((f) => existsSync(f))
  if (!build) return [`No build.gradle(.kts) in ${module.dir}; check release.android.module`]
  if (RELEASE_PLUGIN.test(readFileSync(build, 'utf8'))) return []
  return [
    `${relative(root, build)} does not apply the kit release plugin; add id("io.github.jordond.kit.release") to its plugins block so release builds sign from ANDROID_KEYSTORE_*`,
  ]
}

/** `--out` resolved against the repo root. */
export const resolveOut = (root: string, out: string): string => (isAbsolute(out) ? out : resolve(root, out))

/** True when `file` is inside the repo and git does not ignore it. */
export async function committable(root: string, file: string): Promise<boolean> {
  const rel = relative(root, file)
  if (rel.startsWith('..') || isAbsolute(rel)) return false
  const r = await runPiped(['git', 'check-ignore', '-q', rel], { cwd: root })
  return r.code === 1
}
