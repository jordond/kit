/// <reference lib="dom" />
import type { PageBrand, Slide } from '../types'
import { drawDeviceFrame, roundedRectPath } from './device-frames'

/** What a slide is drawn from besides its own settings. */
export interface SlideSources {
  /** URL of the job's raw shot (`shot/<jobId>`). */
  shot: string
  /** The brand lockup of the plan; `null` draws nothing for `showMascot`. */
  brand: PageBrand | null
  /** The loaded brand mark; set when `brand` is. */
  mark: HTMLImageElement | null
}

/** Loads an image, or throws: a slide is never drawn without its shot. */
export async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = src
  try {
    await img.decode()
  } catch {
    throw new Error(`Failed to load image: ${src}`)
  }
  return img
}

/** Drawn under everything when a slide has no primary colour. */
const FALLBACK_BACKGROUND = '#ffffff'

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
 * Draw background pattern accents
 */
function drawBackgroundPattern(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  width: number,
  height: number,
): void {
  const { pattern, accentColor } = slide.background

  ctx.save()
  if (pattern === 'warm-glow') {
    const glowRadius = width * 0.75
    const cx = width * 0.5
    const cy = height * 0.55
    const grad = ctx.createRadialGradient(cx, cy, 50, cx, cy, glowRadius)
    grad.addColorStop(0, accentColor.includes('rgba') ? accentColor : `${accentColor}33`)
    grad.addColorStop(1, 'transparent')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2)
    ctx.fill()
  } else if (pattern === 'rings') {
    ctx.strokeStyle = accentColor.includes('rgba') ? accentColor : `${accentColor}18`
    ctx.lineWidth = width * 0.015
    for (let r = width * 0.2; r < width * 0.8; r += width * 0.18) {
      ctx.beginPath()
      ctx.arc(width * 0.85, height * 0.25, r, 0, Math.PI * 2)
      ctx.stroke()
    }
  } else if (pattern === 'coffee-beans') {
    ctx.fillStyle = accentColor.includes('rgba') ? accentColor : `${accentColor}15`
    const beanPositions = [
      { x: width * 0.12, y: height * 0.15, r: 24, a: 0.3 },
      { x: width * 0.88, y: height * 0.18, r: 28, a: -0.5 },
      { x: width * 0.08, y: height * 0.42, r: 20, a: 0.8 },
      { x: width * 0.92, y: height * 0.52, r: 22, a: -0.2 },
    ]
    for (const b of beanPositions) {
      ctx.save()
      ctx.translate(b.x, b.y)
      ctx.rotate(b.a)
      ctx.beginPath()
      ctx.ellipse(0, 0, b.r, b.r * 1.5, 0, 0, Math.PI * 2)
      ctx.fill()
      // Center slit
      ctx.strokeStyle = slide.background.primaryColor || FALLBACK_BACKGROUND
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(0, -b.r * 1.1)
      ctx.bezierCurveTo(b.r * 0.3, 0, -b.r * 0.3, 0, 0, b.r * 1.1)
      ctx.stroke()
      ctx.restore()
    }
  } else if (pattern === 'subtle-grid') {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.04)'
    ctx.lineWidth = 1
    const step = width * 0.08
    for (let x = 0; x < width; x += step) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }
    for (let y = 0; y < height; y += step) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * Draw continuous panoramic wave connecting all slides
 */
function drawPanoramaWave(ctx: CanvasRenderingContext2D, slide: Slide, width: number, height: number): void {
  const total = slide.background.panoramaTotalSlides ?? 9
  const index = slide.background.panoramaSlideIndex ?? 0
  const globalWidth = width * total
  const globalOffsetX = index * width

  ctx.save()
  const waveColor = slide.background.accentColor || '#c97b31'
  ctx.fillStyle = waveColor.includes('rgba') ? waveColor : `${waveColor}1a`

  // Continuous harmonic wave curve across all slides
  ctx.beginPath()
  ctx.moveTo(0, height)
  for (let x = 0; x <= width; x += 20) {
    const globalX = globalOffsetX + x
    const waveY =
      height * 0.48 +
      Math.sin((globalX / globalWidth) * Math.PI * 4) * height * 0.12 +
      Math.cos((globalX / globalWidth) * Math.PI * 2) * height * 0.06
    ctx.lineTo(x, waveY)
  }
  ctx.lineTo(width, height)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
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
  ctx.font = `800 ${wordSize}px "${brand.font || slide.headline.fontFamily}", sans-serif`
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
  ctx.font = `700 ${badgeFontSize}px "${badgeFont}", sans-serif`
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
  ctx.font = `700 ${badgeFontSize}px "${badgeFont}", sans-serif`
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
): number {
  let currentY = startY

  // 1. Headline
  if (slide.headline.text.trim()) {
    const headlineFontSize = Math.round(76 * scaleFactor * (slide.headline.fontSize / 100))
    ctx.save()
    ctx.font = `${slide.headline.fontWeight} ${headlineFontSize}px "${slide.headline.fontFamily}", sans-serif`
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
    ctx.font = `${slide.subheadline.fontWeight} ${subFontSize}px "${slide.subheadline.fontFamily}", sans-serif`
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

  return currentY
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
 * fonts before the first draw. Throws when the shot does not load.
 */
export async function renderSlideToCanvas(
  slide: Slide,
  canvas: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
  sources: SlideSources,
): Promise<void> {
  const { brand, mark } = sources
  const img = await loadImage(sources.shot)
  if (!img.naturalWidth || !img.naturalHeight) throw new Error(`Image has no size: ${sources.shot}`)

  canvas.width = targetWidth
  canvas.height = targetHeight
  // Opaque: Chrome then encodes the PNG as RGB, and the stores refuse alpha.
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Could not get 2D canvas rendering context')

  const scaleFactor = targetWidth / 1320

  // Solid background first, so nothing below is drawn onto an unpainted canvas
  ctx.fillStyle = slide.background.primaryColor || FALLBACK_BACKGROUND
  ctx.fillRect(0, 0, targetWidth, targetHeight)

  // Background Gradient / Mesh / Panorama
  if (slide.background.type === 'linear-gradient') {
    const angleRad = ((slide.background.angle - 90) * Math.PI) / 180
    const cx = targetWidth / 2
    const cy = targetHeight / 2
    const length = Math.sqrt(targetWidth * targetWidth + targetHeight * targetHeight) / 2
    const x0 = cx - Math.cos(angleRad) * length
    const y0 = cy - Math.sin(angleRad) * length
    const x1 = cx + Math.cos(angleRad) * length
    const y1 = cy + Math.sin(angleRad) * length

    const grad = ctx.createLinearGradient(x0, y0, x1, y1)
    grad.addColorStop(0, slide.background.primaryColor)
    grad.addColorStop(1, slide.background.secondaryColor)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, targetWidth, targetHeight)
  } else if (slide.background.type === 'radial-gradient') {
    const grad = ctx.createRadialGradient(
      targetWidth * 0.5,
      targetHeight * 0.4,
      targetWidth * 0.1,
      targetWidth * 0.5,
      targetHeight * 0.4,
      targetWidth * 0.85,
    )
    grad.addColorStop(0, slide.background.secondaryColor)
    grad.addColorStop(1, slide.background.primaryColor)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, targetWidth, targetHeight)
  } else if (slide.background.type === 'mesh-glow') {
    const grad1 = ctx.createRadialGradient(
      targetWidth * 0.25,
      targetHeight * 0.3,
      50,
      targetWidth * 0.25,
      targetHeight * 0.3,
      targetWidth * 0.7,
    )
    grad1.addColorStop(0, slide.background.secondaryColor)
    grad1.addColorStop(1, slide.background.primaryColor)
    ctx.fillStyle = grad1
    ctx.fillRect(0, 0, targetWidth, targetHeight)

    const grad2 = ctx.createRadialGradient(
      targetWidth * 0.8,
      targetHeight * 0.7,
      50,
      targetWidth * 0.8,
      targetHeight * 0.7,
      targetWidth * 0.6,
    )
    grad2.addColorStop(0, `${slide.background.accentColor}33`)
    grad2.addColorStop(1, 'transparent')
    ctx.fillStyle = grad2
    ctx.fillRect(0, 0, targetWidth, targetHeight)
  } else if (slide.background.type === 'panorama') {
    drawPanoramaWave(ctx, slide, targetWidth, targetHeight)
  }

  // Draw background decorative patterns
  drawBackgroundPattern(ctx, slide, targetWidth, targetHeight)

  // Header: brand lockup, badge, typography
  let currentY = targetHeight * 0.05
  if (slide.showMascot && slide.mascotPosition === 'top-center' && brand && mark) {
    currentY = drawBrandLockup(ctx, slide, brand, mark, targetWidth, currentY, scaleFactor)
  }
  // The badge has no font of its own in the config: the brand font, else the headline family.
  const badgeFont = brand?.font || slide.headline.fontFamily
  currentY = drawBadge(ctx, slide, badgeFont, targetWidth, currentY, scaleFactor)
  currentY = drawTypography(ctx, slide, targetWidth, currentY, scaleFactor)

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

  const radius = Math.round(slide.device.cornerRadius * scaleFactor)

  ctx.save()

  // 3D rotation & isometric perspective transform
  if (slide.device.rotation !== 0 || slide.device.perspectiveTilt !== 0) {
    const centerX = devX + devW / 2
    const centerY = devY + devH / 2
    ctx.translate(centerX, centerY)
    ctx.rotate((slide.device.rotation * Math.PI) / 180)
    if (slide.device.perspectiveTilt !== 0) {
      // Subtle 3D tilt skew
      ctx.transform(1, 0, (slide.device.perspectiveTilt / 100) * 0.3, 1, 0, 0)
    }
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
}
