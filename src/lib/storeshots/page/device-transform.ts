/**
 * The linear part of the transform the renderer draws the device with, about the device's centre:
 * a rotation, then the perspective tilt's horizontal skew. Shared by the draw and by the editor's
 * hit test so the two cannot drift. Pure: no canvas, no DOM.
 */

/** A 2x2 matrix in canvas `transform(a, b, c, d, 0, 0)` order: x' = a x + c y, y' = b x + d y. */
export interface Linear {
  a: number
  b: number
  c: number
  d: number
}

/** The matrix for `rotation` degrees and `perspectiveTilt` (percent) about the device centre. */
export function deviceLinear(rotation: number, perspectiveTilt: number): Linear {
  const r = (rotation * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const k = (perspectiveTilt / 100) * 0.3
  // rotate(r) followed by transform(1, 0, k, 1): R * [[1, k], [0, 1]].
  return { a: cos, b: sin, c: cos * k - sin, d: sin * k + cos }
}

/** Maps a point relative to the device centre from the drawn canvas back into the device's own frame. */
export function toDeviceFrame(dx: number, dy: number, m: Linear): { x: number; y: number } | null {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-9) return null
  return { x: (m.d * dx - m.c * dy) / det, y: (-m.b * dx + m.a * dy) / det }
}
