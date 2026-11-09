import { describe, expect, test } from 'bun:test'
import { getTomlValue, parseToml, setTomlValue } from '../../src/lib/toml'

const CATALOG = `# Versions shared by every module
[versions]
app-ios-version = "1.4.0"   # bumped by kit version
app-android-version = '1.4.0'
"quoted-key" = "x"
kotlin = "2.4.0"
build = 12
beta = false

[libraries]
kotlin-stdlib = { module = "org.jetbrains.kotlin:kotlin-stdlib", version.ref = "kotlin" }

[plugins.extra]
name = "a"
`

describe('setTomlValue', () => {
  test('edits one value; every other byte is unchanged', () => {
    const out = setTomlValue(CATALOG, 'versions', 'app-ios-version', '1.5.0')
    expect(out).toBe(CATALOG.replace('app-ios-version = "1.4.0"', 'app-ios-version = "1.5.0"'))
    expect(getTomlValue(out, 'versions', 'app-ios-version')).toBe('1.5.0')
  })

  test('keeps the trailing comment', () => {
    const out = setTomlValue(CATALOG, 'versions', 'app-ios-version', '2.0.0')
    expect(out).toContain('app-ios-version = "2.0.0"   # bumped by kit version')
  })

  test('keeps single quotes', () => {
    const out = setTomlValue(CATALOG, 'versions', 'app-android-version', '1.5.0')
    expect(out).toContain("app-android-version = '1.5.0'")
  })

  test('falls back to double quotes when the value has a single quote', () => {
    const out = setTomlValue(CATALOG, 'versions', 'app-android-version', "it's")
    expect(getTomlValue(out, 'versions', 'app-android-version')).toBe("it's")
  })

  test('numbers and booleans stay bare', () => {
    let out = setTomlValue(CATALOG, 'versions', 'build', 13)
    out = setTomlValue(out, 'versions', 'beta', true)
    expect(out).toContain('build = 13\n')
    expect(out).toContain('beta = true\n')
  })

  test('quoted keys, nested tables and the root table', () => {
    expect(setTomlValue(CATALOG, 'versions', 'quoted-key', 'y')).toContain('"quoted-key" = "y"')
    expect(setTomlValue(CATALOG, 'plugins.extra', 'name', 'b')).toContain('name = "b"')
    expect(setTomlValue('top = "a"\n[t]\ntop = "b"\n', '', 'top', 'c')).toBe('top = "c"\n[t]\ntop = "b"\n')
  })

  test('escapes double quotes', () => {
    const out = setTomlValue(CATALOG, 'versions', 'kotlin', 'a"b')
    expect(getTomlValue(out, 'versions', 'kotlin')).toBe('a"b')
  })

  test('the same key in another table is left alone', () => {
    const out = setTomlValue(CATALOG, 'plugins.extra', 'name', 'b')
    expect(parseToml(out)).toEqual({
      ...parseToml(CATALOG),
      plugins: { extra: { name: 'b' } },
    })
  })

  test('missing key or table throws', () => {
    expect(() => setTomlValue(CATALOG, 'versions', 'nope', '1')).toThrow('[versions] nope not found')
    expect(() => setTomlValue(CATALOG, 'nope', 'kotlin', '1')).toThrow('not found')
  })

  test('inline tables and arrays are refused', () => {
    expect(() => setTomlValue(CATALOG, 'libraries', 'kotlin-stdlib', 'x')).toThrow('not a single-line value')
  })

  test('round-trips CRLF files', () => {
    const crlf = CATALOG.replaceAll('\n', '\r\n')
    const out = setTomlValue(crlf, 'versions', 'kotlin', '2.4.10')
    expect(out).toBe(crlf.replace('kotlin = "2.4.0"', 'kotlin = "2.4.10"'))
  })
})
