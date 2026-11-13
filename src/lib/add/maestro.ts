import { join } from 'node:path'
import { ExitCode, KitError } from '../errors'
import { type FileAction, fill, type ReadFile } from '../scaffold'
import { appendProperty, configObject, lineEndings } from './edits'
import type { AddPlan } from './plan'

/**
 * Plan for `kit add maestro`: the starter flows directory (config.yaml, a smoke flow, the settle
 * subflow, the README with the rules) from `templates/add/maestro/`, plus the `maestro: { … }`
 * block in kit.config.ts when the config has none. Pure: the repo comes in through `read`.
 */

/** The Maestro version a new `maestro` block pins; `kit doctor` compares it and CI installs it. */
export const MAESTRO_PIN = '2.9.0'

/** The flows directory a config with no `maestro` block gets. */
export const DEFAULT_MAESTRO_DIR = 'maestro'

/** Bundle ids and Android package names: dot-separated, letters first, no YAML-significant characters. */
const APP_ID = /^[A-Za-z][\w-]*(?:\.[\w-]+)*$/

export function validateAppId(id: string, flag: string): string {
  if (!APP_ID.test(id)) {
    throw new KitError(`${flag} "${id}" is not an app id`, 'e.g. com.example.app', ExitCode.usage)
  }
  return id
}

export interface MaestroInput {
  /** Repo-relative flows directory. */
  dir: string
  ios?: string
  android?: string
  /** Tags the smoke flow carries: the first stage of the `qa` suite. */
  tags: string[]
  configFile: string
  /** True when the config already has a `maestro` block (nothing to add there). */
  hasBlock: boolean
  templates: Record<string, string>
  read: ReadFile
  force?: boolean
}

const q = (s: string, like: string) =>
  like.includes('"') && !like.includes("'")
    ? JSON.stringify(s)
    : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** `maestro: { dir: 'maestro', version: '2.9.0' }`, quoted the way `like` quotes its strings. */
export function maestroSnippet(dir: string, like = ''): string {
  return `maestro: { dir: ${q(dir, like)}, version: ${q(MAESTRO_PIN, like)} }`
}

export type MaestroEdit =
  | { status: 'edited'; content: string }
  | { status: 'exists' }
  /** The file is not a shape kit edits; `snippet` is what to paste into the config object. */
  | { status: 'manual'; snippet: string }

/** kit.config.ts with a `maestro` block appended to its object; the same shapes `withTarget` edits. */
export function withMaestroBlock(source: string, dir: string): MaestroEdit {
  const { lf: text, restore } = lineEndings(source)
  const manual: MaestroEdit = { status: 'manual', snippet: `${maestroSnippet(dir, text)},` }
  const config = configObject(text)
  if (!config) return manual
  if (config.properties.some((p) => p.name === 'maestro')) return { status: 'exists' }
  const content = appendProperty(text, config, (indent, unit) =>
    indent === undefined
      ? maestroSnippet(dir, text)
      : [
          'maestro: {',
          `${indent}${unit}dir: ${q(dir, text)},`,
          `${indent}${unit}version: ${q(MAESTRO_PIN, text)},`,
          `${indent}}`,
        ].join('\n'),
  )
  // Read the result back: the edit stands only if the object now has the same properties plus maestro.
  const after = content === undefined ? undefined : configObject(content)?.properties.map((p) => p.name)
  const before = config.properties.map((p) => p.name)
  if (content === undefined || after?.join('\n') !== [...before, 'maestro'].join('\n')) return manual
  return { status: 'edited', content: restore(content) }
}

/** The `launchApp` step of the smoke flow: one id launches plainly; two ids launch per platform. */
export function launchBlock(ios: string | undefined, android: string | undefined): string {
  const launch = (pad: string, appId?: string) =>
    [
      `${pad}- launchApp:`,
      ...(appId ? [`${pad}    appId: ${appId}`] : []),
      `${pad}    stopApp: true`,
      `${pad}    permissions:`,
      `${pad}      all: allow`,
    ].join('\n')
  if (ios === undefined || android === undefined || ios === android) return launch('')
  const when = (platform: string, id: string) =>
    ['- runFlow:', '    when:', `      platform: ${platform}`, '    commands:', launch('      ', id)].join(
      '\n',
    )
  return [when('iOS', ios), when('Android', android)].join('\n')
}

/** The id the flow headers carry: iOS first, since Maestro needs one `appId` per file. */
export function primaryAppId(ios: string | undefined, android: string | undefined): string {
  const id = ios ?? android
  if (id === undefined) throw new KitError('kit add maestro needs an app id', undefined, ExitCode.usage)
  return id
}

function render(templates: Record<string, string>, file: string, vars: Record<string, string>): string {
  const text = templates[`maestro/${file}`]
  if (text === undefined) throw new Error(`kit template add/maestro/${file} is missing`)
  const out = fill(text, vars)
  const left = out.match(/\{\{\w+\}\}/)
  if (left) throw new Error(`kit template add/maestro/${file}: no value for ${left[0]}`)
  return out
}

/** The files in `<dir>`: relative path under the flows directory, and the template it comes from. */
const FILES = ['config.yaml', 'flows/smoke.yaml', 'subflows/settle.yaml', 'README.md'] as const

export function planMaestro(input: MaestroInput): AddPlan {
  const { dir, read } = input
  const vars = {
    appId: primaryAppId(input.ios, input.android),
    tags: input.tags.map((t) => `  - ${t}`).join('\n'),
    launch: launchBlock(input.ios, input.android),
  }
  const actions: FileAction[] = []
  if (!input.hasBlock) {
    const text = read(input.configFile)
    if (text === undefined) throw new Error(`${input.configFile} is missing`)
    const edit = withMaestroBlock(text, dir)
    if (edit.status === 'manual') {
      return {
        actions: [],
        conflicts: [],
        manual: { file: input.configFile, where: 'the config object', snippet: edit.snippet },
      }
    }
    if (edit.status === 'edited') {
      actions.push({
        kind: 'edit',
        path: input.configFile,
        content: edit.content,
        note: `add maestro.dir ${dir}`,
      })
    }
  }
  const files: [string, string][] = [
    ...FILES.map((f) => [f, render(input.templates, f, vars)] as [string, string]),
    ['.gitignore', 'output/\n'],
  ]
  for (const [rel, content] of files) {
    const path = join(dir, rel)
    if (read(path) === undefined || input.force) actions.push({ kind: 'write', path, content })
    else actions.push({ kind: 'skip', path, reason: 'exists' })
  }
  return { actions, conflicts: [] }
}
