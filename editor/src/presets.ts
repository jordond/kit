import { BUILT_IN_PRESETS } from '../../src/lib/storeshots/presets'
import type { ProjectV2, StyleRules } from '../../src/lib/storeshots/types'

/** One preset the panel lists. */
export interface PresetItem {
  name: string
  rules: StyleRules
  /** From `kit.config.ts` rather than kit. */
  fromRepo: boolean
}

/** The built-in presets, then the repo's; a repo preset named like a built-in one replaces it. */
export function presetList(repo: Record<string, StyleRules>): PresetItem[] {
  const builtIn = Object.entries(BUILT_IN_PRESETS)
    .filter(([name]) => !(name in repo))
    .map(([name, rules]): PresetItem => ({ name, rules, fromRepo: false }))
  const own = Object.entries(repo).map(([name, rules]): PresetItem => ({ name, rules, fromRepo: true }))
  return [...builtIn, ...own]
}

/**
 * Applies a preset to the project's `style` (the All slides layer): the preset's rules replace
 * the layer, so fields it does not mention go back to the default. Overrides on a target or a
 * slide still win over it. An empty preset drops `style`.
 */
export function applyPreset(project: ProjectV2, rules: StyleRules): ProjectV2 {
  const style = structuredClone(rules)
  if (JSON.stringify(style) === JSON.stringify(project.style ?? {})) return project
  const next = { ...project }
  if (Object.keys(style).length > 0) next.style = style
  else delete next.style
  return next
}
