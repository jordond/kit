/// <reference lib="dom" />
import type { Slide } from '../types'

/** Background drawing of a slide: the fill or gradient, the panorama wave, and the pattern accents. */

/** Drawn under everything when a slide has no primary colour. */
const FALLBACK_BACKGROUND = '#ffffff'

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
 * Paint the whole canvas: the solid colour, then the slide's gradient, mesh or panorama, then its
 * pattern accents. Everything else is drawn on top.
 */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  width: number,
  height: number,
): void {
  // Solid background first, so nothing below is drawn onto an unpainted canvas
  ctx.fillStyle = slide.background.primaryColor || FALLBACK_BACKGROUND
  ctx.fillRect(0, 0, width, height)

  // Background Gradient / Mesh / Panorama
  if (slide.background.type === 'linear-gradient') {
    const angleRad = ((slide.background.angle - 90) * Math.PI) / 180
    const cx = width / 2
    const cy = height / 2
    const length = Math.sqrt(width * width + height * height) / 2
    const x0 = cx - Math.cos(angleRad) * length
    const y0 = cy - Math.sin(angleRad) * length
    const x1 = cx + Math.cos(angleRad) * length
    const y1 = cy + Math.sin(angleRad) * length

    const grad = ctx.createLinearGradient(x0, y0, x1, y1)
    grad.addColorStop(0, slide.background.primaryColor)
    grad.addColorStop(1, slide.background.secondaryColor)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, width, height)
  } else if (slide.background.type === 'radial-gradient') {
    const grad = ctx.createRadialGradient(
      width * 0.5,
      height * 0.4,
      width * 0.1,
      width * 0.5,
      height * 0.4,
      width * 0.85,
    )
    grad.addColorStop(0, slide.background.secondaryColor)
    grad.addColorStop(1, slide.background.primaryColor)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, width, height)
  } else if (slide.background.type === 'mesh-glow') {
    const grad1 = ctx.createRadialGradient(
      width * 0.25,
      height * 0.3,
      50,
      width * 0.25,
      height * 0.3,
      width * 0.7,
    )
    grad1.addColorStop(0, slide.background.secondaryColor)
    grad1.addColorStop(1, slide.background.primaryColor)
    ctx.fillStyle = grad1
    ctx.fillRect(0, 0, width, height)

    const grad2 = ctx.createRadialGradient(
      width * 0.8,
      height * 0.7,
      50,
      width * 0.8,
      height * 0.7,
      width * 0.6,
    )
    grad2.addColorStop(0, `${slide.background.accentColor}33`)
    grad2.addColorStop(1, 'transparent')
    ctx.fillStyle = grad2
    ctx.fillRect(0, 0, width, height)
  } else if (slide.background.type === 'panorama') {
    drawPanoramaWave(ctx, slide, width, height)
  }

  drawBackgroundPattern(ctx, slide, width, height)
}
