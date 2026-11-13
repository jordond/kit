import { describe, expect, test } from 'bun:test'
import { type DotenvFormat, dotenvEncode, dotenvLine, dotenvValue } from '../../src/lib/dotenv'
import { setKey } from '../../src/lib/env/init'
import { parseDotenv, render } from '../../src/lib/env/render'
import { rewriteKey } from '../../src/lib/env/rotate'
import { KitError } from '../../src/lib/errors'
import { bunEnvFile, dotenvExpand, dotenvParse } from '../helpers/dotenv-consumers'

/** Values a bare `KEY=value` would lose or change for some reader. */
const SINGLE = [
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
  "'open",
  '`open',
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
  // Dollars: Bun and dotenv-expand would expand these in `.env`.
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
  '$HOME',
  '${HOME}',
  '${X}',
  'pre$HOME',
  'pa$$word',
  '$$',
  '$',
  'a$',
  'a$ b',
  '100$',
  '$1abc',
  '\\$HOME',
  '${X:-def}',
  'p$ss#1',
  "it's $HOME #",
  'x "$HOME" \'#',
  '$(whoami)',
  '`whoami` #',
  '${',
  '$}',
  '$#',
  '#$HOME',
  "'$HOME'",
  '"$HOME"',
  '`$HOME`',
  '\\${HOME}',
  'postgres://u:p$w@h/db',
  'a\\$b',
  'a\\\\$b',
  '#a$',
  ' $',
  '$ ',
  'a$\\',
  "it's $ # $",
  // Backslashes.
  'end\\',
  '#x\\',
  "it's #\\",
  'q"#\\',
  'a\\tb',
  'a\\\\b',
  'a\\"b',
  "a\\'b",
  'a\\`b',
  '#a\\"b',
  "#a\\'b",
  '#a\\`b',
  '\\',
  '\\\\',
  '#\\\\',
  '\\#',
  'a \\# b',
  'a\\',
  "'\\",
  '"\\',
  "it's\\ #",
  'x\\ y',
  '\\x41',
  '\\u0041',
  '\\0',
  'a\\rb',
  'a\\rb #',
  "a\\rb # '",
  'a\\nb #',
  "a\\nb # '",
  'a\\$',
  '#a\\$',
  'a\\$ #',
  // Quotes and shapes that look like syntax.
  '"',
  "'",
  '`',
  "''",
  '""',
  '``',
  "'a'b",
  '"a" b',
  "a'",
  'a"',
  'a`',
  `' " \` plain`,
  `' " \` #`,
  'a b  c',
  'a  # b',
  ' # ',
  '#',
  ' ',
  '  ',
  'x\u00a0',
  '\u00a0x',
  'é#ü',
  'export X=1',
  'K=v',
  'a: b',
  '{"a":"b"}',
  '{"a":"b#c"}',
  '{"a":"it\'s#"}',
  '[1,2] # x',
  'a;b',
  'a&b|c',
  'a*b?',
  '~/x',
  '!x',
  '%PATH%',
  'a,b',
  '<x>',
  '(x)',
  'a\vb',
  'a\fb',
  '\vlead',
  'trail\f',
  '\uFEFFbom',
  'emoji 😀 #',
  '0',
  'true',
  'null',
  '-----BEGIN-----',
  'https://u:p@h/x?y=1#frag',
  'Bearer abc.def#',
  '',
]

const MULTI = [
  'a\nb',
  'a\r\nb',
  'a\rb',
  '-----BEGIN PRIVATE KEY-----\nabc+/=\n-----END PRIVATE KEY-----\n',
  'a\n#b',
  "a\nit's",
  'a\n`b` #c',
  'a\n$HOME',
  '$\n$',
  'a$\nb',
  ' lead\ntrail ',
  'a\\tb\nc',
  '\n',
  'a\n\nb',
  // Not expressible on one dotenv line.
  '{\n "k": "v"\n}',
  '{\n "k": "a\\nb"\n}',
  'a\n"b" #c',
  'a\\nb\nc',
  'a\\rb\nc',
  'a\\\nb',
  'a\nb\\',
]

const VALUES = [...SINGLE, ...MULTI]

type Writer = { name: string; format: DotenvFormat; write: (key: string, value: string) => string }

const rewriteStarts: ((k: string) => string)[] = [
  () => '',
  () => 'A=1',
  () => 'A=1\r\n',
  (k) => `${k}=old\n`,
  (k) => `${k}="old"\n`,
  (k) => `${k}='old # x'\n`,
  (k) => `${k}=\`old\`\n`,
  (k) => `${k}=old # note\n`,
  (k) => `${k}="old" # note\r\n`,
  (k) => `export ${k} = old  \n`,
  (k) => `${k}=\n`,
  (k) => `${k}= # note\n`,
]

const WRITERS: Writer[] = [
  { name: 'dotenvLine env', format: 'env', write: (k, v) => `${dotenvLine(k, v, 'env')}\n` },
  { name: 'setKey append', format: 'env', write: (k, v) => setKey('A=1\n', k, v) },
  { name: 'setKey replace', format: 'env', write: (k, v) => setKey(`# c\n${k}="old"\nZ=9\n`, k, v) },
  ...rewriteStarts.map(
    (start, i): Writer => ({
      name: `rewriteKey ${JSON.stringify(start('K'))} #${i}`,
      format: 'env',
      write: (k, v) => rewriteKey(start(k), k, v),
    }),
  ),
  { name: 'dotenvLine vars', format: 'vars', write: (k, v) => `${dotenvLine(k, v, 'vars')}\n` },
  {
    name: 'render pick',
    format: 'vars',
    // An unset key renders as a `# KEY=` placeholder, not a line; the literal writer covers ''.
    write: (k, v) =>
      v === '' ? `${k}=\n` : render({ path: 'p', lines: [{ name: k, source: 'S' }] }, { S: v }),
  },
  {
    name: 'render vars literal',
    format: 'vars',
    write: (k, v) => render({ path: 'p', lines: [{ name: k, source: k, value: v }] }, {}),
  },
]

/** Whether kit refuses to write `value` in `format`, by asking the one encoder. */
function refused(value: string, format: DotenvFormat): boolean {
  try {
    dotenvEncode('K', value, format)
    return false
  } catch {
    return true
  }
}

interface Row {
  key: string
  writer: string
  value: string
  text: string
}

function rows(format: DotenvFormat): Row[] {
  const out: Row[] = []
  for (const value of VALUES) {
    if (refused(value, format)) continue
    for (const w of WRITERS.filter((x) => x.format === format)) {
      const key = `K${out.length}`
      const text = w.write(key, value)
      out.push({ key, writer: w.name, value, text: text.endsWith('\n') ? text : `${text}\n` })
    }
  }
  return out
}

const show = (r: Row, reader: string, got: unknown) =>
  `${JSON.stringify(r.value)} via ${r.writer}, read by ${reader} as ${JSON.stringify(got)} from ${JSON.stringify(r.text)}`

describe('dotenv writers against their consumers', () => {
  test('.env: every writer × every value reads back identical in kit, dotenv-expand and bun --env-file', async () => {
    const all = rows('env')
    expect(all.length).toBeGreaterThan(1500)
    const file = `${all.map((r) => r.text).join('')}END_OF_FILE=reached\n`
    const bun = await bunEnvFile(file, [...all.map((r) => r.key), 'END_OF_FILE'])
    const expanded = dotenvExpand(dotenvParse(file), { HOME: '/home/kit-test' })
    const bad: string[] = []
    for (const r of all) {
      const kit = parseDotenv(r.text, 'env')[r.key]
      if (kit !== r.value) bad.push(show(r, 'kit', kit))
      // Each row alone and inside the whole file: a line must not swallow its neighbours.
      const alone = dotenvExpand(dotenvParse(r.text), { HOME: '/home/kit-test' })[r.key]
      if (alone !== r.value) bad.push(show(r, 'dotenv-expand', alone))
      if (expanded[r.key] !== r.value) bad.push(show(r, 'dotenv-expand (whole file)', expanded[r.key]))
      if (bun[r.key] !== r.value) bad.push(show(r, 'bun --env-file', bun[r.key]))
    }
    expect(bun.END_OF_FILE).toBe('reached')
    expect(expanded.END_OF_FILE).toBe('reached')
    expect(bad).toEqual([])
  })

  test('.dev.vars: every writer × every value reads back identical in kit and dotenv parse', () => {
    const all = rows('vars')
    expect(all.length).toBeGreaterThan(400)
    const file = `${all.map((r) => r.text).join('')}END_OF_FILE=reached\n`
    const parsed = dotenvParse(file)
    const bad: string[] = []
    for (const r of all) {
      const kit = parseDotenv(r.text, 'vars')[r.key]
      if (kit !== r.value) bad.push(show(r, 'kit', kit))
      const alone = dotenvParse(r.text)[r.key]
      if (alone !== r.value) bad.push(show(r, 'dotenv parse', alone))
      if (parsed[r.key] !== r.value) bad.push(show(r, 'dotenv parse (whole file)', parsed[r.key]))
    }
    expect(parsed.END_OF_FILE).toBe('reached')
    expect(bad).toEqual([])
  })

  test('a value kit refuses is refused by every writer, exit 3, naming the key and not the value', () => {
    // Need quotes, and no quote style holds them: a final backslash, or all three quote characters.
    const quoteless = ['#x\\', "it's #\\", 'q"#\\', '#\\\\', "'\\", '"\\', `' " \` #`, `' " \` plain`]
    const multiline = [
      '{\n "k": "v"\n}',
      '{\n "k": "a\\nb"\n}',
      'a\n"b" #c',
      'a\\nb\nc',
      'a\\rb\nc',
      'a\\\nb',
      'a\nb\\',
    ]
    const expected: Record<DotenvFormat, string[]> = {
      env: [...quoteless, 'a\\$', '#a\\$', ...multiline],
      vars: [...quoteless, ...multiline],
    }
    for (const format of ['env', 'vars'] as const) {
      expect(VALUES.filter((v) => refused(v, format)).sort()).toEqual([...expected[format]].sort())
      for (const value of expected[format]) {
        for (const w of WRITERS.filter((x) => x.format === format)) {
          let err: unknown
          try {
            w.write('SOME_KEY', value)
          } catch (e) {
            err = e
          }
          expect(err).toBeInstanceOf(KitError)
          expect((err as KitError).exitCode).toBe(3)
          expect((err as KitError).message).toContain('Cannot write SOME_KEY')
          if (value.length > 3) expect((err as KitError).message).not.toContain(value)
        }
      }
    }
  })
})

describe('dotenvValue', () => {
  test('a raw value that starts with # is empty plus a comment', () => {
    expect(dotenvValue('# note', 'env')).toBe('')
    expect(dotenvValue('#', 'vars')).toBe('')
    expect(parseDotenv('A= # note\nB=#x\nC=1\n', 'env')).toEqual({ A: '', B: '', C: '1' })
  })

  test('quotes of all three kinds; a # inside them is the value', () => {
    expect(dotenvValue("'a # b'", 'env')).toBe('a # b')
    expect(dotenvValue('"#x" # note', 'env')).toBe('#x')
    expect(dotenvValue('`it\'s "x"` # note', 'vars')).toBe('it\'s "x"')
    expect(dotenvValue('plain # note', 'vars')).toBe('plain')
    expect(dotenvValue('no#space', 'env')).toBe('no#space')
  })

  test('\\n and \\r are expanded in double quotes only, so a hand-written PEM is multi-line', () => {
    expect(dotenvValue('"-----BEGIN-----\\nabc\\n-----END-----\\n"', 'env')).toBe(
      '-----BEGIN-----\nabc\n-----END-----\n',
    )
    expect(dotenvValue('"a\\r\\nb"', 'vars')).toBe('a\r\nb')
    expect(dotenvValue("'a\\nb'", 'env')).toBe('a\\nb')
    expect(dotenvValue('`a\\nb`', 'vars')).toBe('a\\nb')
    expect(dotenvValue('a\\nb', 'env')).toBe('a\\nb')
    expect(dotenvValue('"a\\tb"', 'env')).toBe('a\\tb')
  })

  test('.env: \\$ is a dollar, an unescaped $ is left as written; .dev.vars: nothing is unescaped', () => {
    expect(dotenvValue('\\$2b\\$10\\$abc', 'env')).toBe('$2b$10$abc')
    expect(dotenvValue("'p\\$ss#1'", 'env')).toBe('p$ss#1')
    expect(dotenvValue('pa\\$$', 'env')).toBe('pa$$')
    expect(dotenvValue('$HOME and ${X}', 'env')).toBe('$HOME and ${X}')
    // As Bun reads it: a final `\$` is not an escape.
    expect(dotenvValue('a\\$', 'env')).toBe('a\\$')
    expect(dotenvValue('\\$2b\\$10', 'vars')).toBe('\\$2b\\$10')
  })
})

describe('dotenvEncode', () => {
  const enc = (v: string, prefer?: string) => dotenvEncode('K', v, 'vars', prefer)

  test('bare when that reads back intact, else the first quote style the value does not hold', () => {
    expect(enc('plain')).toBe('plain')
    expect(enc('two words')).toBe('two words')
    expect(enc('a"b')).toBe('a"b')
    expect(enc('')).toBe('')
    expect(enc('end\\')).toBe('end\\')
    expect(enc('p@ss #1')).toBe("'p@ss #1'")
    expect(enc('mid#dle')).toBe("'mid#dle'")
    expect(enc("it's #1")).toBe('"it\'s #1"')
    expect(enc(`' " #`)).toBe('`\' " #`')
    expect(enc(' lead')).toBe("' lead'")
    expect(enc('"wrapped"')).toBe('\'"wrapped"\'')
  })

  test('double quotes are skipped for a literal \\n, which is expanded there', () => {
    expect(enc("it's \\n #")).toBe("`it's \\n #`")
    expect(enc('a\\nb', '"')).toBe('a\\nb')
  })

  test('the preferred style is kept when the value fits it', () => {
    expect(enc('plain', '"')).toBe('"plain"')
    expect(enc('say "hi"', '"')).toBe('say "hi"')
    expect(enc('say "hi" #1', '"')).toBe('\'say "hi" #1\'')
  })

  test('a multi-line value is double-quoted, LF as \\n and CR as \\r', () => {
    expect(enc('a\nb\r\nc\rd')).toBe('"a\\nb\\r\\nc\\rd"')
  })

  test('.env escapes every $ but a final one; .dev.vars writes $ raw', () => {
    expect(dotenvEncode('K', '$2b$10$abc', 'env')).toBe('\\$2b\\$10\\$abc')
    expect(dotenvEncode('K', '$2b$10$abc', 'vars')).toBe('$2b$10$abc')
    expect(dotenvEncode('K', 'p$ss#1', 'env')).toBe("'p\\$ss#1'")
    expect(dotenvEncode('K', 'pa$$', 'env')).toBe('pa\\$$')
    expect(dotenvEncode('K', '${X}', 'env')).toBe('\\${X}')
    expect(dotenvEncode('K', 'a$\nb', 'env')).toBe('"a\\$\\nb"')
  })

  test('refusals say why and suggest a way out', () => {
    expect(() => enc('#x\\')).toThrow(/ends in a backslash/)
    expect(() => enc(`' " \` #`)).toThrow(/no quote style can hold it/)
    expect(() => enc('{\n "k": "v"\n}')).toThrow(/multi-line/)
    expect(() => dotenvEncode('K', 'a\\$', 'env')).toThrow(/Cannot write K to \.env/)
    expect(() => dotenvEncode('K', 'a\\$', 'vars')).not.toThrow()
  })
})

describe('rewriteKey and dotenv syntax', () => {
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
    expect(rewriteKey('A=old\n', 'A', '$2b$10')).toBe('A=\\$2b\\$10\n')
  })

  test('the empty value', () => {
    expect(parseDotenv(setKey('', 'K', ''), 'env').K).toBe('')
    expect(parseDotenv(rewriteKey('K=old # note\n', 'K', ''), 'env').K).toBe('')
    // The renderer writes a `# K=` placeholder for an unset key and `K=` for an empty literal.
    expect(parseDotenv(render({ path: 'p', lines: [{ name: 'K', source: 'K' }] }, { K: '' }), 'vars').K).toBe(
      '',
    )
    expect(render({ path: 'p', lines: [{ name: 'K', source: 'K', value: '' }] }, {})).toContain('\nK=\n')
  })
})

describe('dotenvAmbiguities', () => {
  test('flags lines Bun, dotenv and kit read differently, by name and line only', async () => {
    const { dotenvAmbiguities } = await import('../../src/lib/dotenv')
    const text = [
      'OK=plain',
      'COMMENTED=value # note',
      "QUOTED='a#b $x is fine here? no'",
      'HASH=abc#def',
      'DOLLAR=$2b$10$abc',
      'ESCAPED=a\\$b',
      'TRAILING=ends$',
      'OPEN="line one',
      'EMPTY= # note',
      '# COMMENT=a#b',
      'export BOTH=a#b$c',
    ].join('\n')
    const found = dotenvAmbiguities(text)
    expect(found.map((w) => [w.key, w.line])).toEqual([
      ['QUOTED', 3],
      ['HASH', 4],
      ['DOLLAR', 5],
      ['OPEN', 8],
      ['BOTH', 11],
      ['BOTH', 11],
    ])
    expect(found.find((w) => w.key === 'HASH')!.reason).toContain('#')
    expect(found.find((w) => w.key === 'QUOTED')!.reason).toContain('$')
    expect(JSON.stringify(found)).not.toContain('abc')
    expect(JSON.stringify(found)).not.toContain('2b')
  })

  test('nothing kit writes is flagged', async () => {
    const { dotenvAmbiguities, dotenvLine } = await import('../../src/lib/dotenv')
    for (const value of [
      'a#b',
      ' padded ',
      '$2b$10$abc',
      'a$ b',
      "it's",
      'x # y',
      'line\nbreak',
      'plain',
      '',
    ]) {
      expect(dotenvAmbiguities(dotenvLine('K', value, 'env'))).toEqual([])
    }
  })
})
