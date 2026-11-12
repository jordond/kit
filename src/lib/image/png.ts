import { deflateSync, inflateSync } from 'node:zlib'
import { ExitCode, KitError } from '../errors'

/**
 * Just enough image code for store screenshots, with no native dependency: read a PNG's or a JPEG's
 * size and whether it carries alpha (the stores reject alpha), flatten a PNG onto a background
 * colour, and encode raw pixels as a PNG.
 */

export interface ImageInfo {
  format: 'png' | 'jpeg'
  width: number
  height: number
  /** PNG colour type 4 or 6, or a `tRNS` chunk. Always false for JPEG. */
  alpha: boolean
}

/** 8-bit red, green, blue. */
export type Rgb = readonly [number, number, number]

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const bad = (message: string): KitError => new KitError(message, undefined, ExitCode.precondition)

const u32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0

const isPng = (b: Uint8Array): boolean => PNG_MAGIC.every((v, i) => b[i] === v)

interface PngChunk {
  type: string
  data: Uint8Array
}

/** Every chunk up to and including IEND; a chunk that runs past the end or a missing IEND throws. */
function pngChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = []
  let at = PNG_MAGIC.length
  for (;;) {
    if (at + 12 > bytes.length) throw bad('Truncated PNG: the data ends before the IEND chunk')
    const length = u32(bytes, at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const end = at + 8 + length
    if (end + 4 > bytes.length) throw bad(`Truncated PNG: the ${type} chunk runs past the end of the data`)
    chunks.push({ type, data: bytes.subarray(at + 8, end) })
    if (type === 'IEND') return chunks
    at = end + 4
  }
}

interface PngHeader {
  width: number
  height: number
  depth: number
  colorType: number
  interlace: number
}

function pngHeader(chunks: PngChunk[]): PngHeader {
  const ihdr = chunks[0]
  if (ihdr?.type !== 'IHDR' || ihdr.data.length !== 13) throw bad('Invalid PNG: the first chunk is not IHDR')
  const d = ihdr.data
  return { width: u32(d, 0), height: u32(d, 4), depth: d[8]!, colorType: d[9]!, interlace: d[12]! }
}

function pngInfo(bytes: Uint8Array): ImageInfo {
  const chunks = pngChunks(bytes)
  const { width, height, colorType } = pngHeader(chunks)
  if (!width || !height) throw bad('Invalid PNG: zero width or height')
  const alpha = colorType === 4 || colorType === 6 || chunks.some((c) => c.type === 'tRNS')
  return { format: 'png', width, height, alpha }
}

/** JPEG: the size sits in the first start-of-frame segment (SOF0 to SOF15, less DHT, JPG and DAC). */
function jpegInfo(bytes: Uint8Array): ImageInfo {
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw bad('Invalid JPEG: expected a segment marker')
    const marker = bytes[at + 1]!
    // Fill bytes before a marker, and the markers that carry no length (TEM, RSTn, SOI).
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    // EOI or start of scan: the frame header always comes first.
    if (marker === 0xd9 || marker === 0xda) break
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (sof) {
      if (at + 9 > bytes.length) break
      const height = (bytes[at + 5]! << 8) | bytes[at + 6]!
      const width = (bytes[at + 7]! << 8) | bytes[at + 8]!
      if (!width || !height) throw bad('Invalid JPEG: zero width or height')
      return { format: 'jpeg', width, height, alpha: false }
    }
    if (length < 2) throw bad('Invalid JPEG: a segment shorter than its own length field')
    at += 2 + length
  }
  throw bad('Truncated JPEG: the data ends before the frame header')
}

/**
 * Format, pixel size and alpha of a PNG or JPEG, read from the header bytes (PNG `IHDR` and `tRNS`,
 * JPEG start-of-frame). The format comes from the magic bytes, never a file name.
 *
 * Throws a KitError (exit 4) for data that is neither format, a PNG that ends before `IEND`, or a
 * JPEG that ends before its frame header. The message names no file: the caller adds it.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo {
  if (bytes.length >= PNG_MAGIC.length && isPng(bytes)) return pngInfo(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegInfo(bytes)
  if (bytes.length < PNG_MAGIC.length && PNG_MAGIC.slice(0, bytes.length).every((v, i) => bytes[i] === v)) {
    throw bad('Truncated PNG: the data ends inside the signature')
  }
  throw bad('Not a PNG or JPEG image')
}

/** `#rgb` or `#rrggbb` as 8-bit channels; anything else is a usage error. */
export function parseHexColor(value: string): Rgb {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1]
  if (!hex) {
    throw new KitError(`"${value}" is not a hex colour`, 'Use #rgb or #rrggbb, e.g. #ffffff', ExitCode.usage)
  }
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  const name = Uint8Array.from(type, (c) => c.charCodeAt(0))
  view.setUint32(0, data.length)
  out.set(name, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32([name, data]))
  return out
}

/**
 * Encode 8-bit pixels as a non-interlaced PNG. `pixels` is row-major, top row first:
 * `width * height * 3` bytes of RGB give an RGB PNG (colour type 2, no alpha), and
 * `width * height * 4` bytes of RGBA give an RGBA PNG (colour type 6; for tests and fakes: kit
 * never writes alpha to a store dir). Any other length throws.
 */
export function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const channels = pixels.length === width * height * 4 ? 4 : 3
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new KitError(`Cannot encode a ${width}x${height} PNG`)
  }
  if (pixels.length !== width * height * channels) {
    throw new KitError(
      `Cannot encode a ${width}x${height} PNG from ${pixels.length} bytes`,
      `RGB needs ${width * height * 3} bytes, RGBA ${width * height * 4}`,
    )
  }
  const stride = width * channels
  // Each scanline is its filter byte (0: none) followed by the row.
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  const parts = [
    Uint8Array.from(PNG_MAGIC),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Samples per pixel for each PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Undo the per-scanline filters in place; returns the rows without their filter bytes. */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  if (raw.length < (stride + 1) * height) throw bad('Truncated PNG: the image data is shorter than its size')
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp]! : 0
      const b = y > 0 ? out[row + x - stride]! : 0
      const c = x >= bpp && y > 0 ? out[row + x - stride - bpp]! : 0
      let predicted = 0
      if (filter === 1) predicted = a
      else if (filter === 2) predicted = b
      else if (filter === 3) predicted = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw bad(`Invalid PNG: unknown scanline filter ${filter}`)
      out[row + x] = (raw[src + x]! + predicted) & 0xff
    }
  }
  return out
}

/**
 * Composite a PNG onto an opaque `background` (`#rgb`, `#rrggbb`, or channels) and return an RGB
 * PNG (colour type 2, no `tRNS`) of the same size. An RGB PNG without alpha comes back unchanged.
 *
 * Reads 8-bit, non-interlaced PNGs of every colour type (what Chrome's `--screenshot` writes is
 * 8-bit RGBA); 16-bit, sub-byte and interlaced PNGs throw a KitError (exit 4), as does truncated data.
 */
export function flattenPng(bytes: Uint8Array, background: string | Rgb): Uint8Array {
  if (bytes.length < PNG_MAGIC.length || !isPng(bytes)) throw bad('Not a PNG image')
  const chunks = pngChunks(bytes)
  const { width, height, depth, colorType, interlace } = pngHeader(chunks)
  const trns = chunks.find((c) => c.type === 'tRNS')?.data
  if (colorType === 2 && depth === 8 && !trns) return bytes
  const channels = CHANNELS[colorType]
  if (depth !== 8 || interlace !== 0 || channels === undefined) {
    throw bad(
      `Cannot flatten this PNG (bit depth ${depth}, colour type ${colorType}${interlace ? ', interlaced' : ''}): only 8-bit, non-interlaced PNGs are read`,
    )
  }
  const bg = typeof background === 'string' ? parseHexColor(background) : background
  const palette = chunks.find((c) => c.type === 'PLTE')?.data
  if (colorType === 3 && !palette) throw bad('Invalid PNG: a palette image without a PLTE chunk')

  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)
  let raw: Uint8Array
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    throw bad('Invalid PNG: the image data does not inflate')
  }
  const px = unfilter(raw, height, width * channels, channels)

  // A colour key (`tRNS` on grey or RGB) makes exactly one colour fully transparent; samples are 16-bit.
  const key =
    trns && colorType === 0
      ? [trns[1]!]
      : trns && colorType === 2
        ? [trns[1]!, trns[3]!, trns[5]!]
        : undefined
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const at = i * channels
    let r: number
    let g: number
    let b: number
    let a = 255
    if (colorType === 3) {
      const index = px[at]!
      r = palette![index * 3] ?? 0
      g = palette![index * 3 + 1] ?? 0
      b = palette![index * 3 + 2] ?? 0
      a = trns?.[index] ?? 255
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = px[at]!
      if (colorType === 4) a = px[at + 1]!
      else if (key && r === key[0]) a = 0
    } else {
      r = px[at]!
      g = px[at + 1]!
      b = px[at + 2]!
      if (colorType === 6) a = px[at + 3]!
      else if (key && r === key[0] && g === key[1] && b === key[2]) a = 0
    }
    const over = (c: number, under: number) => (a === 255 ? c : Math.round((c * a + under * (255 - a)) / 255))
    rgb[i * 3] = over(r, bg[0])
    rgb[i * 3 + 1] = over(g, bg[1])
    rgb[i * 3 + 2] = over(b, bg[2])
  }
  return encodePng(width, height, rgb)
}
