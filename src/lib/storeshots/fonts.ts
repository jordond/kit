/**
 * Font family strings, shared by the font check (`command.ts`) and the page (`page/`). The page is
 * bundled for the browser, so this file imports nothing.
 */

/** Families the browser resolves itself; every other family a slide names has to be in `shots.fonts`. */
export const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace', 'system-ui'] as const

/** The generic a family names, lower-cased; undefined for a named family. */
function generic(family: string): string | undefined {
  const name = family.trim().toLowerCase()
  return (GENERIC_FAMILIES as readonly string[]).includes(name) ? name : undefined
}

export const isGenericFamily = (family: string): boolean => generic(family) !== undefined

/**
 * A family as CSS takes it: a generic bare (`"serif"` in quotes is a font named serif, which no
 * machine has), a named family quoted.
 */
export function cssFamily(family: string): string {
  return generic(family) ?? `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The `font-family` list text is drawn in: the family, then the fallback the font check names. */
export const fontStack = (family: string): string => `${cssFamily(family)}, sans-serif`
