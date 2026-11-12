import { describe, expect, test } from 'bun:test'
import { dotenvEncode, dotenvLine, dotenvValue } from '../../src/lib/dotenv'
import { setKey } from '../../src/lib/env/init'
import { parseDotenv, render } from '../../src/lib/env/render'
import { rewriteKey } from '../../src/lib/env/rotate'
import { KitError } from '../../src/lib/errors'

/** Values a bare `KEY=value` would lose or change on the way back in. */
const AWKWARD = [
  'plain',
  'two words',
  'p@ss #1',
  '#start',
  'mid#dle',
  'ends with #',
  "it's",
  'say "hi"',
  `both ' and "`,
  '`ticks`',
  "'wrapped'",
  '"wrapped"',
  '"open',
  'a=b=c',
  '=',
  ' lead',
  'trail ',
  '\ttab\t',
  'back\\slash',
  'literal\\nnot-a-newline',
  `it's "literal\\n" #1`,
  'C:\\dir\\name # x',
  '$HOME $X',
]

/** Read a line the way `loadDotEnv` and `parseDotenv` do: trim around the raw value, then `dotenvValue`. */
function readBack(text: string, key = 'K'): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && m[1] === key) return dotenvValue(m[2]!)
  }
  return undefined
}

describe('dotenvValue', () => {
  test('a raw value that starts with # is empty plus a comment', () => {
    expect(dotenvValue('# note')).toBe('')
    expect(dotenvValue('#')).toBe('')
    expect(parseDotenv('A= # note\nB=#x\nC=1\n')).toEqual({ A: '', B: '', C: '1' })
  })

  test('quotes of all three kinds; a # inside them is the value', () => {
    expect(dotenvValue("'a # b'")).toBe('a # b')
    expect(dotenvValue('"#x" # note')).toBe('#x')
    expect(dotenvValue('`it\'s "x"` # note')).toBe('it\'s "x"')
    expect(dotenvValue('plain # note')).toBe('plain')
    expect(dotenvValue('no#space')).toBe('no#space')
  })
})

describe('dotenvEncode', () => {
  test('bare when that reads back intact, else the first quote style the value does not hold', () => {
    expect(dotenvEncode('plain')).toBe('plain')
    expect(dotenvEncode('two words')).toBe('two words')
    expect(dotenvEncode('a"b')).toBe('a"b')
    expect(dotenvEncode('')).toBe('')
    expect(dotenvEncode('p@ss #1')).toBe("'p@ss #1'")
    expect(dotenvEncode('mid#dle')).toBe("'mid#dle'")
    expect(dotenvEncode("it's #1")).toBe('"it\'s #1"')
    expect(dotenvEncode(`' " #`)).toBe('`\' " #`')
    expect(dotenvEncode(' lead')).toBe("' lead'")
    expect(dotenvEncode('"wrapped"')).toBe('\'"wrapped"\'')
  })

  test('double quotes are skipped for a literal \\n, which dotenv would expand there', () => {
    expect(dotenvEncode("it's \\n #")).toBe("`it's \\n #`")
    expect(dotenvEncode('a\\nb', '"')).toBe('a\\nb')
  })

  test('the preferred style is kept when the value fits it', () => {
    expect(dotenvEncode('plain', '"')).toBe('"plain"')
    expect(dotenvEncode('say "hi"', '"')).toBe('say "hi"')
    expect(dotenvEncode('say "hi" #1', '"')).toBe('\'say "hi" #1\'')
  })

  test('a multi-line value is double-quoted with \\n', () => {
    expect(dotenvEncode('a\nb\r\nc')).toBe('"a\\nb\\nc"')
  })

  test('a value holding every quote character cannot be written: exit 3 naming the key, not the value', () => {
    let err: unknown
    try {
      dotenvLine('TOKEN', `a' "b\` #`)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KitError)
    expect((err as KitError).exitCode).toBe(3)
    expect((err as KitError).message).toContain('Cannot write TOKEN')
    expect((err as KitError).message).not.toContain('"b')
    // Bare is still fine when nothing forces quotes.
    expect(dotenvLine('TOKEN', `a' "b\``)).toBe(`TOKEN=a' "b\``)
  })
})

describe('every dotenv writer round-trips awkward values', () => {
  for (const value of AWKWARD) {
    const label = JSON.stringify(value)

    test(`dotenvLine ${label}`, () => {
      expect(readBack(dotenvLine('K', value))).toBe(value)
    })

    test(`env init setKey ${label}`, () => {
      expect(parseDotenv(setKey('', 'K', value)).K).toBe(value)
      expect(parseDotenv(setKey('A=1\n', 'K', value))).toEqual({ A: '1', K: value })
      expect(parseDotenv(setKey('# c\nK="old"\nZ=9\n', 'K', value))).toEqual({ K: value, Z: '9' })
    })

    test(`output renderer ${label}`, () => {
      const picked = render({ path: 'x/.dev.vars', lines: [{ name: 'K', source: 'SRC' }] }, { SRC: value })
      expect(parseDotenv(picked).K).toBe(value)
      const literal = render({ path: 'x/.dev.vars', lines: [{ name: 'K', source: 'K', value }] }, {})
      expect(parseDotenv(literal).K).toBe(value)
    })

    test(`env rotate rewriteKey ${label}`, () => {
      const starts = [
        '',
        'A=1',
        'A=1\r\n',
        'K=old\n',
        'K="old"\n',
        "K='old # x'\n",
        'K=`old`\n',
        'K=old # note\n',
        'K="old" # note\r\n',
        'export K = old  \n',
        'K=\n',
        'K= # note\n',
      ]
      for (const start of starts) {
        const next = rewriteKey(start, 'K', value)
        expect(readBack(next)).toBe(value)
        // An inline comment on the line survives the rewrite.
        if (start.includes('# note')) expect(next).toContain('# note')
      }
    })
  }

  test('the empty value', () => {
    expect(parseDotenv(setKey('', 'K', '')).K).toBe('')
    expect(readBack(rewriteKey('K=old # note\n', 'K', ''))).toBe('')
    // The renderer writes a `# K=` placeholder for an unset key and `K=` for an empty literal.
    expect(parseDotenv(render({ path: 'p', lines: [{ name: 'K', source: 'K' }] }, { K: '' })).K).toBe('')
    expect(render({ path: 'p', lines: [{ name: 'K', source: 'K', value: '' }] }, {})).toContain('\nK=\n')
  })
})

describe('rewriteKey on an empty value with a comment', () => {
  test('`KEY= # note` keeps the comment', () => {
    expect(rewriteKey('A= # note\nB=2\n', 'A', 'new')).toBe('A=new # note\nB=2\n')
    expect(rewriteKey('A=# note\r\n', 'A', 'new')).toBe('A=new # note\r\n')
    expect(rewriteKey('export A =   # note\n', 'A', 'new')).toBe('export A =new # note\n')
  })

  test('a new value that needs quotes gets them, in the line’s style when it fits', () => {
    expect(rewriteKey('A=old # note\n', 'A', 'p@ss #1')).toBe("A='p@ss #1' # note\n")
    expect(rewriteKey('A="old"\n', 'A', 'p@ss #1')).toBe('A="p@ss #1"\n')
    expect(rewriteKey('A="old"\n', 'A', 'say "hi"')).toBe('A=say "hi"\n')
    expect(rewriteKey('', 'A', ' lead')).toBe("A=' lead'\n")
  })
})
