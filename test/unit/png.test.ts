import { describe, expect, test } from 'bun:test'
import { deflateSync, inflateSync } from 'node:zlib'
import { KitError } from '../../src/lib/errors'
import { encodePng, flattenPng, imageInfo, parseHexColor } from '../../src/lib/image/png'

const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A chunk with a zero CRC: the reader does not verify it. */
function chunk(type: string, data: number[] | Uint8Array): number[] {
  const len = data.length
  return [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ]
}

/** A hand-built PNG: `rows` are unfiltered scanlines, `extra` chunks sit between IHDR and IDAT. */
function png(width: number, height: number, colorType: number, rows: number[][], extra: number[] = []) {
  const ihdr = [0, 0, 0, width, 0, 0, 0, height, 8, colorType, 0, 0, 0]
  const raw = Uint8Array.from(rows.flatMap((r) => [0, ...r]))
  return Uint8Array.from([
    ...MAGIC,
    ...chunk('IHDR', ihdr),
    ...extra,
    ...chunk('IDAT', deflateSync(raw)),
    ...chunk('IEND', []),
  ])
}

/** The RGB pixels of an 8-bit RGB PNG written by encodePng (filter 0 on every row). */
function pixels(bytes: Uint8Array): number[] {
  const { width, height } = imageInfo(bytes)
  const at = bytes.indexOf(0x49, 33) // 'I' of IDAT, after the 33-byte signature and IHDR
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at - 4)
  const raw = inflateSync(bytes.subarray(at + 4, at + 4 + length))
  const out: number[] = []
  for (let y = 0; y < height; y++)
    out.push(...raw.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)))
  return out
}

/** A minimal JPEG: SOI, an APP0 segment to skip, a start-of-frame, EOI. */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...[0xff, 0xe0, 0, 4, 0x4a, 0x46],
    ...[0xff, sof, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0],
    0xff,
    0xd9,
  ])
}

describe('imageInfo', () => {
  test('an RGB PNG has no alpha', () => {
    const bytes = encodePng(3, 2, new Uint8Array(18))
    expect(imageInfo(bytes)).toEqual({ format: 'png', width: 3, height: 2, alpha: false })
  })

  test('an RGBA PNG has alpha (colour type 6)', () => {
    const bytes = encodePng(2, 2, new Uint8Array(16))
    expect(imageInfo(bytes)).toEqual({ format: 'png', width: 2, height: 2, alpha: true })
  })

  test('grey with alpha (colour type 4) has alpha', () => {
    expect(imageInfo(png(1, 1, 4, [[10, 128]])).alpha).toBe(true)
  })

  test('a palette PNG has alpha only with a tRNS chunk', () => {
    const plte = chunk('PLTE', [255, 0, 0, 0, 0, 255])
    expect(imageInfo(png(2, 1, 3, [[0, 1]], plte))).toEqual({
      format: 'png',
      width: 2,
      height: 1,
      alpha: false,
    })
    expect(imageInfo(png(2, 1, 3, [[0, 1]], [...plte, ...chunk('tRNS', [0])])).alpha).toBe(true)
  })

  test('reads the full 32-bit size', () => {
    expect(imageInfo(encodePng(1320, 2, new Uint8Array(1320 * 2 * 3)))).toMatchObject({
      width: 1320,
      height: 2,
    })
  })

  test('a JPEG gives its frame size and never alpha, baseline or progressive', () => {
    expect(imageInfo(jpeg(1440, 2560))).toEqual({ format: 'jpeg', width: 1440, height: 2560, alpha: false })
    expect(imageInfo(jpeg(1024, 500, 0xc2))).toMatchObject({ width: 1024, height: 500 })
  })

  test('a truncated PNG throws a KitError with exit 4', () => {
    const bytes = encodePng(4, 4, new Uint8Array(48))
    for (const cut of [4, 20, 40, bytes.length - 1]) {
      let error: unknown
      try {
        imageInfo(bytes.subarray(0, cut))
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(KitError)
      expect((error as KitError).message).toContain('Truncated PNG')
      expect((error as KitError).exitCode).toBe(4)
    }
  })

  test('a JPEG that ends before its frame header throws', () => {
    expect(() => imageInfo(jpeg(10, 10).subarray(0, 10))).toThrow('Truncated JPEG')
  })

  test('unknown or empty data throws', () => {
    expect(() => imageInfo(new TextEncoder().encode('x'))).toThrow('Not a PNG or JPEG image')
    expect(() => imageInfo(new Uint8Array(0))).toThrow(KitError)
    expect(() => imageInfo(new TextEncoder().encode('GIF89a..........'))).toThrow('Not a PNG or JPEG image')
  })
})

describe('encodePng', () => {
  test('round-trips RGB pixels', () => {
    const rgb = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 8, 7])
    expect(pixels(encodePng(2, 2, rgb))).toEqual([...rgb])
  })

  test('refuses a pixel buffer of the wrong length', () => {
    expect(() => encodePng(2, 2, new Uint8Array(5))).toThrow(KitError)
    expect(() => encodePng(0, 2, new Uint8Array(0))).toThrow(KitError)
  })
})

describe('flattenPng', () => {
  test('composites RGBA over the background and drops the alpha channel', () => {
    // Opaque red, transparent, half-transparent black, opaque white.
    const rgba = Uint8Array.from([255, 0, 0, 255, 1, 2, 3, 0, 0, 0, 0, 128, 255, 255, 255, 255])
    const flat = flattenPng(encodePng(2, 2, rgba), '#ffffff')
    expect(imageInfo(flat)).toEqual({ format: 'png', width: 2, height: 2, alpha: false })
    expect(pixels(flat)).toEqual([255, 0, 0, 255, 255, 255, 127, 127, 127, 255, 255, 255])
  })

  test('takes the background as #rgb, #rrggbb or channels', () => {
    const clear = encodePng(1, 1, Uint8Array.from([0, 0, 0, 0]))
    expect(pixels(flattenPng(clear, '#faf2e4'))).toEqual([0xfa, 0xf2, 0xe4])
    expect(pixels(flattenPng(clear, '#f00'))).toEqual([255, 0, 0])
    expect(pixels(flattenPng(clear, [1, 2, 3]))).toEqual([1, 2, 3])
    expect(() => flattenPng(clear, 'red')).toThrow('not a hex colour')
  })

  test('an RGB PNG comes back unchanged', () => {
    const rgb = encodePng(2, 1, Uint8Array.from([1, 2, 3, 4, 5, 6]))
    expect(flattenPng(rgb, '#000000')).toBe(rgb)
  })

  test('reads filtered scanlines (sub, up, average, paeth)', () => {
    // 2x4 RGBA, opaque: every row is (10,20,30) (40,60,80), each written with a different filter.
    const sub = [1, 10, 20, 30, 255, 30, 40, 50, 0]
    const up = [2, 0, 0, 0, 0, 0, 0, 0, 0]
    const avg = [3, 5, 10, 15, 128, 15, 20, 25, 0]
    const paeth = [4, 0, 0, 0, 0, 0, 0, 0, 0]
    const ihdr = [0, 0, 0, 2, 0, 0, 0, 4, 8, 6, 0, 0, 0]
    const bytes = Uint8Array.from([
      ...MAGIC,
      ...chunk('IHDR', ihdr),
      ...chunk('IDAT', deflateSync(Uint8Array.from([...sub, ...up, ...avg, ...paeth]))),
      ...chunk('IEND', []),
    ])
    const rgb = [10, 20, 30, 40, 60, 80]
    expect(pixels(flattenPng(bytes, '#ffffff'))).toEqual([...rgb, ...rgb, ...rgb, ...rgb])
  })

  test('a palette PNG with tRNS flattens through the palette', () => {
    const extra = [...chunk('PLTE', [255, 0, 0, 0, 0, 255]), ...chunk('tRNS', [255, 0])]
    const flat = flattenPng(png(2, 1, 3, [[0, 1]], extra), '#00ff00')
    expect(imageInfo(flat).alpha).toBe(false)
    expect(pixels(flat)).toEqual([255, 0, 0, 0, 255, 0])
  })

  test('refuses 16-bit and interlaced PNGs, and data that is not a PNG', () => {
    const deep = png(1, 1, 6, [[0, 0, 0, 0, 0, 0, 0, 0]])
    deep[24] = 16
    expect(() => flattenPng(deep, '#fff')).toThrow('only 8-bit, non-interlaced')
    const interlaced = encodePng(1, 1, Uint8Array.from([0, 0, 0, 0]))
    interlaced[28] = 1
    expect(() => flattenPng(interlaced, '#fff')).toThrow('interlaced')
    expect(() => flattenPng(jpeg(1, 1), '#fff')).toThrow('Not a PNG image')
  })

  test('a truncated PNG throws', () => {
    const bytes = encodePng(2, 2, new Uint8Array(16))
    expect(() => flattenPng(bytes.subarray(0, bytes.length - 6), '#fff')).toThrow('Truncated PNG')
  })
})

test('parseHexColor', () => {
  expect(parseHexColor('#FAF2E4')).toEqual([250, 242, 228])
  expect(parseHexColor('abc')).toEqual([170, 187, 204])
  expect(() => parseHexColor('rgb(0,0,0)')).toThrow(KitError)
})
