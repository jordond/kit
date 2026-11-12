/// <reference lib="dom" />
import type { FrameColor, FrameType } from '../types'

export interface FrameColors {
  outerBorder: string
  innerBorder: string
  bezelFill: string
  highlight: string
}

export function getFrameColors(color: FrameColor): FrameColors {
  switch (color) {
    case 'titanium-natural':
      return {
        outerBorder: '#8c857b',
        innerBorder: '#3d3a36',
        bezelFill: '#1a1918',
        highlight: 'rgba(255, 255, 255, 0.2)',
      }
    case 'titanium-black':
      return {
        outerBorder: '#282829',
        innerBorder: '#141415',
        bezelFill: '#0e0e0f',
        highlight: 'rgba(255, 255, 255, 0.1)',
      }
    case 'titanium-desert':
      return {
        outerBorder: '#b89980',
        innerBorder: '#4a3b2f',
        bezelFill: '#241a12',
        highlight: 'rgba(255, 240, 220, 0.22)',
      }
    case 'titanium-silver':
      return {
        outerBorder: '#c5c6c9',
        innerBorder: '#55585d',
        bezelFill: '#1e1f21',
        highlight: 'rgba(255, 255, 255, 0.3)',
      }
    case 'espresso':
      return {
        outerBorder: '#5e3825',
        innerBorder: '#2c1a10',
        bezelFill: '#1a0e07',
        highlight: 'rgba(201, 123, 49, 0.25)',
      }
    case 'cream':
      return {
        outerBorder: '#d4c5a9',
        innerBorder: '#6e634e',
        bezelFill: '#2e281e',
        highlight: 'rgba(255, 255, 255, 0.35)',
      }
  }
}

/**
 * Helper to draw a rounded rectangle path on canvas
 */
export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.arcTo(x + width, y, x + width, y + r, r)
  ctx.lineTo(x + width, y + height - r)
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r)
  ctx.lineTo(x + r, y + height)
  ctx.arcTo(x, y + height, x, y + height - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

const BEZEL_RATIO: Record<FrameType, number> = {
  'iphone-pro': 0.013,
  'ipad-pro': 0.024,
  'android-pixel': 0.013,
  'clay-minimal': 0.009,
  'glass-card': 0.013,
  frameless: 0,
}

/**
 * Draw complete sleek device frame around the screen (NO cutouts covering app UI)
 */
export function drawDeviceFrame(
  ctx: CanvasRenderingContext2D,
  type: FrameType,
  color: FrameColor,
  screenWidth: number,
  screenHeight: number,
  screenCornerRadius: number,
): void {
  if (type === 'frameless') return

  const colors = getFrameColors(color)
  // Bezel width is proportional to screen width: slim on a phone, and an iPad's is wider
  // in proportion to its screen, or the frame reads as a phone stretched sideways.
  const bezelWidth = Math.max(6, Math.round(screenWidth * BEZEL_RATIO[type]))
  const outerRadius = screenCornerRadius + bezelWidth

  ctx.save()

  if (type === 'iphone-pro' || type === 'ipad-pro') {
    // 1. Sleek Outer Titanium Chassis
    ctx.lineWidth = bezelWidth
    ctx.strokeStyle = colors.outerBorder
    roundedRectPath(
      ctx,
      -bezelWidth / 2,
      -bezelWidth / 2,
      screenWidth + bezelWidth,
      screenHeight + bezelWidth,
      outerRadius,
    )
    ctx.stroke()

    // 2. Fine outer bevel highlight
    ctx.lineWidth = Math.max(1, Math.round(bezelWidth * 0.15))
    ctx.strokeStyle = colors.highlight
    roundedRectPath(
      ctx,
      -bezelWidth + 1,
      -bezelWidth + 1,
      screenWidth + bezelWidth * 2 - 2,
      screenHeight + bezelWidth * 2 - 2,
      outerRadius,
    )
    ctx.stroke()

    // 3. Ultra-thin inner screen rim
    ctx.lineWidth = 1.5
    ctx.strokeStyle = colors.innerBorder
    roundedRectPath(ctx, -0.75, -0.75, screenWidth + 1.5, screenHeight + 1.5, screenCornerRadius + 0.5)
    ctx.stroke()

    // NOTE: All cutouts (Dynamic Island, notches) are intentionally omitted
    // because screenshots already render the native app status bar and UI.
  } else if (type === 'android-pixel') {
    // 1. Modern symmetrical slim bezel
    ctx.lineWidth = bezelWidth
    ctx.strokeStyle = colors.outerBorder
    roundedRectPath(
      ctx,
      -bezelWidth / 2,
      -bezelWidth / 2,
      screenWidth + bezelWidth,
      screenHeight + bezelWidth,
      outerRadius,
    )
    ctx.stroke()

    // 2. Inner screen rim
    ctx.lineWidth = 1.5
    ctx.strokeStyle = colors.innerBorder
    roundedRectPath(ctx, -0.75, -0.75, screenWidth + 1.5, screenHeight + 1.5, screenCornerRadius + 0.5)
    ctx.stroke()

    // NOTE: Punch hole camera cutout is intentionally omitted
    // so it never obscures title bars, icons, or app content.
  } else if (type === 'clay-minimal') {
    // Clean, subtle clay matte frame
    ctx.lineWidth = bezelWidth
    ctx.strokeStyle = colors.outerBorder
    roundedRectPath(
      ctx,
      -bezelWidth / 2,
      -bezelWidth / 2,
      screenWidth + bezelWidth,
      screenHeight + bezelWidth,
      outerRadius,
    )
    ctx.stroke()
  } else if (type === 'glass-card') {
    // Frosted glass edge
    ctx.lineWidth = Math.max(4, Math.round(screenWidth * 0.008))
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
    roundedRectPath(ctx, -3, -3, screenWidth + 6, screenHeight + 6, screenCornerRadius + 3)
    ctx.stroke()
  }

  ctx.restore()
}
