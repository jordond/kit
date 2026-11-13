/// <reference lib="dom" />

import { fontStack } from '../fonts'
import type { PageBrand, Slide } from '../types'
import { drawBackground } from './background'
import { deviceLinear } from './device-transform'
import { drawDeviceFrame, roundedRectPath } from './device-frames'

/** What a slide is drawn from besides its own settings. */
export interface SlideSources {
  /**
   * URL of the job's raw shot (`shot/<jobId>`), or the shot already loaded: the editor redraws one
   * shot many times and keeps the decoded image instead of fetching it on every draw.
   */
  shot: string | HTMLImageElement
  /** The brand lockup of the plan; `null` draws nothing for `showMascot`. */
  brand: PageBrand | null
  /** The loaded brand mark; set when `brand` is. */
  mark: HTMLImageElement | null
}

/**
 * Where a draw put things, in pixels of the canvas it drew on. The editor measures text overflow
 * from it and hit-tests the device with it; the export page ignores it.
 */
export interface SlideLayout {
  /** The canvas size the draw used. */
  width: number
  height: number
  /** Lines the headline wrapped into; 0 when there is none. */
  headlineLines: number
  subheadlineLines: number
  /** Where the header (brand lockup, badge, headline, subheadline) ends. */
  textBottom: number
  /** The device's rect before rotation and tilt, as drawn (`yOffset` and `xOffset` included). */
  device: { x: number; y: number; width: number; height: number }
  /** True when the position puts the device under the text (so more text pushes it down). */
  textPushesDevice: boolean
}

/** Loads an image, or throws naming `what` it is: the URL means nothing to whoever reads the error. */
export async function loadImage(src: string, what: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = src
  try {
    await img.decode()
  } catch {
    throw new Error(`${what} does not load as an image`)
  }
  return img
}

/**
 * Wraps text into lines that fit within maxWidth
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let currentLine = words[0] || ''

  for (let i = 1; i < words.length; i++) {
    const word = words[i]!
    const testLine = `${currentLine} ${word}`
    const metrics = ctx.measureText(testLine)
    if (metrics.width > maxWidth) {
      lines.push(currentLine)
      currentLine = word
    } else {
      currentLine = testLine
    }
  }
  if (currentLine) lines.push(currentLine)
  return lines
}

/**
 * Brand mark + wordmark, centred, the mark about 1.2x the wordmark. Kept small so the headline
 * under it stays the thing legible at thumbnail size. Without a wordmark the mark stands alone.
 */
function drawBrandLockup(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  brand: PageBrand,
  mark: HTMLImageElement,
  width: number,
  startY: number,
  scaleFactor: number,
): number {
  const markSize = Math.round(72 * scaleFactor)
  const wordSize = Math.round(60 * scaleFactor)
  const word = brand.wordmark?.trim() ?? ''
  const gap = word ? Math.round(10 * scaleFactor) : 0

  ctx.save()
  ctx.font = `800 ${wordSize}px ${fontStack(brand.font || slide.headline.fontFamily)}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const wordWidth = word ? ctx.measureText(word).width : 0
  const totalWidth = markSize + gap + wordWidth
  const x = (width - totalWidth) / 2
  const centerY = startY + markSize / 2

  ctx.drawImage(mark, x, startY, markSize, markSize)
  if (word) {
    ctx.fillStyle = brand.color || slide.headline.color
    ctx.fillText(word, x + markSize + gap, centerY + wordSize * 0.06)
  }
  ctx.restore()

  return startY + markSize + 36 * scaleFactor
}

/**
 * Draw badge pill at top
 */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  badgeFont: string,
  width: number,
  startY: number,
  scaleFactor: number,
): number {
  if (!slide.badge.enabled || !slide.badge.text.trim()) return startY

  const badgeFontSize = Math.round(24 * scaleFactor * (slide.badge.fontSize / 100))
  ctx.font = `700 ${badgeFontSize}px ${fontStack(badgeFont)}`
  const text = slide.badge.text.toUpperCase()
  const textMetrics = ctx.measureText(text)

  const iconPadding = slide.badge.icon !== 'none' ? badgeFontSize * 1.2 : 0
  const pillPaddingX = badgeFontSize * 1.1
  const pillPaddingY = badgeFontSize * 0.5
  const pillWidth = textMetrics.width + pillPaddingX * 2 + iconPadding
  const pillHeight = badgeFontSize + pillPaddingY * 2
  const pillX = (width - pillWidth) / 2
  const pillY = startY

  ctx.save()
  // Badge background
  ctx.fillStyle = slide.badge.backgroundColor
  roundedRectPath(ctx, pillX, pillY, pillWidth, pillHeight, pillHeight / 2)
  ctx.fill()

  // Badge border
  if (slide.badge.borderColor) {
    ctx.lineWidth = Math.max(1, 1.5 * scaleFactor)
    ctx.strokeStyle = slide.badge.borderColor
    roundedRectPath(ctx, pillX, pillY, pillWidth, pillHeight, pillHeight / 2)
    ctx.stroke()
  }

  // Draw Icon
  let textStartX = pillX + pillPaddingX
  if (slide.badge.icon !== 'none') {
    const iconX = textStartX + badgeFontSize * 0.4
    const iconY = pillY + pillHeight / 2
    ctx.fillStyle = slide.badge.textColor
    ctx.font = `600 ${badgeFontSize}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    let symbol = '✦'
    if (slide.badge.icon === 'star') symbol = '★'
    else if (slide.badge.icon === 'heart') symbol = '♥'
    else if (slide.badge.icon === 'cup') symbol = '☕'
    else if (slide.badge.icon === 'sparkles') symbol = '✨'
    else if (slide.badge.icon === 'map') symbol = '📍'
    else if (slide.badge.icon === 'check') symbol = '✓'

    ctx.fillText(symbol, iconX, iconY)
    textStartX += iconPadding
  }

  // Draw text
  ctx.fillStyle = slide.badge.textColor
  ctx.font = `700 ${badgeFontSize}px ${fontStack(badgeFont)}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, textStartX, pillY + pillHeight / 2 + 1)
  ctx.restore()

  return pillY + pillHeight + 20 * scaleFactor
}

/**
 * Draw headline and subheadline
 */
function drawTypography(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  width: number,
  startY: number,
  scaleFactor: number,
): { bottom: number; headlineLines: number; subheadlineLines: number } {
  let currentY = startY
  let headlineLines = 0
  let subheadlineLines = 0

  // 1. Headline
  if (slide.headline.text.trim()) {
    const headlineFontSize = Math.round(76 * scaleFactor * (slide.headline.fontSize / 100))
    ctx.save()
    ctx.font = `${slide.headline.fontWeight} ${headlineFontSize}px ${fontStack(slide.headline.fontFamily)}`
    ctx.textAlign = slide.headline.align
    ctx.textBaseline = 'top'

    if (slide.headline.shadow) {
      ctx.shadowColor = slide.headline.shadowColor
      ctx.shadowBlur = slide.headline.shadowBlur * scaleFactor
      ctx.shadowOffsetY = 4 * scaleFactor
    }

    ctx.fillStyle = slide.headline.color
    const maxWidth = width * 0.84
    const lines = wrapText(ctx, slide.headline.text, maxWidth)
    headlineLines = lines.length
    const lineHeight = headlineFontSize * slide.headline.lineHeight

    const x =
      slide.headline.align === 'center'
        ? width / 2
        : slide.headline.align === 'right'
          ? width * 0.92
          : width * 0.08

    for (const line of lines) {
      ctx.fillText(line, x, currentY)
      currentY += lineHeight
    }
    ctx.restore()
    currentY += 12 * scaleFactor
  }

  // 2. Subheadline
  if (slide.subheadline.text.trim()) {
    const subFontSize = Math.round(38 * scaleFactor * (slide.subheadline.fontSize / 100))
    ctx.save()
    ctx.font = `${slide.subheadline.fontWeight} ${subFontSize}px ${fontStack(slide.subheadline.fontFamily)}`
    ctx.textAlign = slide.subheadline.align
    ctx.textBaseline = 'top'

    if (slide.subheadline.shadow) {
      ctx.shadowColor = slide.subheadline.shadowColor
      ctx.shadowBlur = slide.subheadline.shadowBlur * scaleFactor
      ctx.shadowOffsetY = 3 * scaleFactor
    }

    ctx.fillStyle = slide.subheadline.color
    const maxWidth = width * 0.8
    const lines = wrapText(ctx, slide.subheadline.text, maxWidth)
    subheadlineLines = lines.length
    const lineHeight = subFontSize * slide.subheadline.lineHeight

    const x =
      slide.subheadline.align === 'center'
        ? width / 2
        : slide.subheadline.align === 'right'
          ? width * 0.9
          : width * 0.1

    for (const line of lines) {
      ctx.fillText(line, x, currentY)
      currentY += lineHeight
    }
    ctx.restore()
  }

  return { bottom: currentY, headlineLines, subheadlineLines }
}

/**
 * Draw shadow underneath the device
 */
function drawDeviceShadow(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  devX: number,
  devY: number,
  devW: number,
  devH: number,
  radius: number,
  scaleFactor: number,
): void {
  const elev = slide.device.shadowElevation
  if (elev === 'none') return

  ctx.save()
  let blur = 40 * scaleFactor
  let offsetY = 25 * scaleFactor
  let alpha = 0.35

  if (elev === 'subtle') {
    blur = 25 * scaleFactor
    offsetY = 15 * scaleFactor
    alpha = 0.22
  } else if (elev === 'medium') {
    blur = 50 * scaleFactor
    offsetY = 30 * scaleFactor
    alpha = 0.35
  } else if (elev === 'deep') {
    blur = 80 * scaleFactor
    offsetY = 50 * scaleFactor
    alpha = 0.45
  } else if (elev === 'dramatic') {
    blur = 120 * scaleFactor
    offsetY = 75 * scaleFactor
    alpha = 0.6
  }

  ctx.shadowColor = slide.device.shadowColor || `rgba(30, 20, 15, ${alpha})`
  ctx.shadowBlur = blur
  ctx.shadowOffsetY = offsetY
  ctx.shadowOffsetX = 0

  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
  roundedRectPath(ctx, devX, devY, devW, devH, radius)
  ctx.fill()
  ctx.restore()
}

/**
 * Renders one slide onto `canvas` at exactly `targetWidth` x `targetHeight`. The caller loads the
 * fonts before the first draw. Throws when the shot does not load. Returns where the draw put the
 * text and the device.
 */
export async function renderSlideToCanvas(
  slide: Slide,
  canvas: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
  sources: SlideSources,
): Promise<SlideLayout> {
  const { brand, mark } = sources
  // A slide is never drawn without its shot. The render host adds which file the job's shot is.
  const img = typeof sources.shot === 'string' ? await loadImage(sources.shot, 'The raw shot') : sources.shot
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('The raw shot has no size')

  canvas.width = targetWidth
  canvas.height = targetHeight
  // Opaque: Chrome then encodes the PNG as RGB, and the stores refuse alpha.
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Could not get 2D canvas rendering context')

  const scaleFactor = targetWidth / 1320

  drawBackground(ctx, slide, targetWidth, targetHeight)

  // Header: brand lockup, badge, typography
  let currentY = targetHeight * 0.05
  if (slide.showMascot && slide.mascotPosition === 'top-center' && brand && mark) {
    currentY = drawBrandLockup(ctx, slide, brand, mark, targetWidth, currentY, scaleFactor)
  }
  // The badge has no font of its own in the config: the brand font, else the headline family.
  const badgeFont = brand?.font || slide.headline.fontFamily
  currentY = drawBadge(ctx, slide, badgeFont, targetWidth, currentY, scaleFactor)
  const text = drawTypography(ctx, slide, targetWidth, currentY, scaleFactor)
  currentY = text.bottom

  // Shot and device frame
  const imgAspect = img.naturalWidth / img.naturalHeight

  // Calculate Device Dimensions
  let devW = targetWidth * 0.84 * slide.device.scale
  let devH = devW / imgAspect
  let devX = (targetWidth - devW) / 2 + (slide.device.xOffset / 100) * targetWidth
  let devY =
    Math.max(currentY + targetHeight * 0.03, targetHeight - devH * 0.82) +
    (slide.device.yOffset / 100) * targetHeight

  if (slide.device.position === 'center-float') {
    devW = targetWidth * 0.78 * slide.device.scale
    devH = devW / imgAspect
    devX = (targetWidth - devW) / 2 + (slide.device.xOffset / 100) * targetWidth
    devY = (targetHeight - devH) / 2 + (slide.device.yOffset / 100) * targetHeight
  } else if (slide.device.position === 'top-peek') {
    devY = -devH * 0.22 + (slide.device.yOffset / 100) * targetHeight
  } else if (slide.device.position === 'full-bleed') {
    devW = targetWidth * 0.96 * slide.device.scale
    devH = devW / imgAspect
    devX = (targetWidth - devW) / 2 + (slide.device.xOffset / 100) * targetWidth
    devY = currentY + 16 * scaleFactor + (slide.device.yOffset / 100) * targetHeight
  }

  const textPushesDevice = slide.device.position === 'bottom-peek' || slide.device.position === 'full-bleed'
  const radius = Math.round(slide.device.cornerRadius * scaleFactor)

  ctx.save()

  // 3D rotation & isometric perspective transform
  if (slide.device.rotation !== 0 || slide.device.perspectiveTilt !== 0) {
    const centerX = devX + devW / 2
    const centerY = devY + devH / 2
    ctx.translate(centerX, centerY)
    // Rotation then a subtle 3D tilt skew; `deviceLinear` is also what the editor hit-tests with.
    const m = deviceLinear(slide.device.rotation, slide.device.perspectiveTilt)
    ctx.transform(m.a, m.b, m.c, m.d, 0, 0)
    ctx.translate(-centerX, -centerY)
  }

  // Draw Drop Shadow
  drawDeviceShadow(ctx, slide, devX, devY, devW, devH, radius, scaleFactor)

  // Clip screen area and draw screenshot
  ctx.save()
  roundedRectPath(ctx, devX, devY, devW, devH, radius)
  ctx.clip()
  ctx.drawImage(img, devX, devY, devW, devH)

  // Optional Glass Reflection
  if (slide.device.showReflection) {
    const reflGrad = ctx.createLinearGradient(devX, devY, devX + devW * 0.7, devY + devH * 0.4)
    reflGrad.addColorStop(0, 'rgba(255, 255, 255, 0.16)')
    reflGrad.addColorStop(0.3, 'rgba(255, 255, 255, 0.04)')
    reflGrad.addColorStop(1, 'transparent')
    ctx.fillStyle = reflGrad
    ctx.fillRect(devX, devY, devW, devH)
  }
  ctx.restore()

  // Draw Device Hardware Bezel & Dynamic Island / Punch Hole
  ctx.save()
  ctx.translate(devX, devY)
  drawDeviceFrame(ctx, slide.device.frameType, slide.device.color, devW, devH, radius)
  ctx.restore()

  ctx.restore()

  if (slide.showMascot && slide.mascotPosition !== 'top-center' && mark) {
    const mascotSize = targetWidth * 0.16
    let mx = targetWidth * 0.8
    let my = targetHeight * 0.84

    if (slide.mascotPosition === 'top-left') {
      mx = targetWidth * 0.05
      my = targetHeight * 0.06
    } else if (slide.mascotPosition === 'top-right') {
      mx = targetWidth * 0.8
      my = targetHeight * 0.06
    } else if (slide.mascotPosition === 'bottom-left') {
      mx = targetWidth * 0.05
      my = targetHeight * 0.84
    }

    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)'
    ctx.shadowBlur = 20 * scaleFactor
    ctx.shadowOffsetY = 10 * scaleFactor
    ctx.drawImage(mark, mx, my, mascotSize, mascotSize)
    ctx.restore()
  }

  return {
    width: targetWidth,
    height: targetHeight,
    headlineLines: text.headlineLines,
    subheadlineLines: text.subheadlineLines,
    textBottom: text.bottom,
    device: { x: devX, y: devY, width: devW, height: devH },
    textPushesDevice,
  }
}
