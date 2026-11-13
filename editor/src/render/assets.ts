import { cssFamily } from '../../../src/lib/storeshots/fonts'
import { loadImage } from '../../../src/lib/storeshots/page/renderer'
import type { PageFont } from '../../../src/lib/storeshots/types'
import { assetUrl } from '../api'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Loads one face and proves it is usable. A canvas draw of an unloaded face paints the fallback
 * without any error, so a face that fails here is an error, not a quiet fallback.
 */
async function loadFont(font: PageFont): Promise<void> {
  const name = font.weight ? `${font.family} (${font.weight})` : font.family
  const face = new FontFace(
    font.family,
    `url("${assetUrl(font.url)}")`,
    font.weight ? { weight: font.weight } : {},
  )
  try {
    await face.load()
  } catch (err) {
    throw new Error(`Failed to load font ${name}: ${message(err)}`)
  }
  document.fonts.add(face)
  // A range (`400 800`) is checked at its first weight.
  const weight = font.weight?.trim().split(/\s+/)[0] || '400'
  if (!document.fonts.check(`${weight} 16px ${cssFamily(font.family)}`)) {
    throw new Error(`Font ${name} loaded but is not usable`)
  }
}

/** Loads every font of `shots.fonts`; the first draw waits for this. */
export async function loadFonts(fonts: readonly PageFont[]): Promise<void> {
  await Promise.all(fonts.map(loadFont))
}

const images = new Map<string, Promise<HTMLImageElement>>()

/**
 * A decoded image by URL, loaded once. Shots and the brand mark are drawn many times (every edit,
 * every thumbnail), and the server sends `no-store`, so the browser would otherwise fetch each draw.
 */
export function cachedImage(url: string, what: string): Promise<HTMLImageElement> {
  let image = images.get(url)
  if (!image) {
    image = loadImage(url, what)
    // A failure is not kept: a retry loads again.
    image.catch(() => images.delete(url))
    images.set(url, image)
  }
  return image
}

/** Forgets a decoded image, for a file that was replaced under the same URL. */
export const forgetImage = (url: string): void => void images.delete(url)
