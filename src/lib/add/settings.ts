import { CLOSERS, lineEndings, lineStart, matchClose, skip } from './edits'

/**
 * The settings.gradle(.kts) edit of `kit add module`: one more `include`, after the last top-level
 * include statement. Same rules as ./edits.ts: the file's formatting and line endings are kept,
 * an included project is a no-op, and a shape kit does not recognise is `manual`. Pure.
 */

const projectPath = (s: string) => s.replace(/^:/, '')

interface IncludeStatement {
  /** Just past the statement's last character (the `)` or the last string). */
  end: number
  indent: string
  paths: string[]
  /**
   * A statement of its own at the top level: not inside a block or call, nothing before it on its
   * line, and nothing after it that carries the expression on (an operator, a `.call`, a `{`).
   * Only such a statement can have another include put on the line after it.
   */
  anchor: boolean
}

/**
 * Every `include` statement outside comments and strings: the call form `include(":a", ":b")`
 * (any line layout, comments inside) and Groovy's command form `include ':a', ':b'`, which
 * continues over lines after a comma. Undefined when the text does not scan (unbalanced
 * brackets, an unterminated string or comment).
 */
function includeStatements(settings: string): IncludeStatement[] | undefined {
  const out: IncludeStatement[] = []
  const quoted = (i: number) => settings[i] === '"' || settings[i] === "'"
  /** Next index at or after `i` that is not a comment or blank; newlines count as blank when `lines`. */
  const next = (i: number, lines: boolean): number => {
    while (i < settings.length) {
      const j = skip(settings, i)
      if (j < 0) return -1
      if (j !== i && settings[i] === '/') i = j
      else if (settings[i] === ' ' || settings[i] === '\t' || (lines && /\s/.test(settings[i]!))) i++
      else break
    }
    return i
  }
  let depth = 0
  for (let i = 0; i < settings.length; ) {
    const j = skip(settings, i)
    if (j < 0) return undefined
    if (j !== i) {
      i = j
      continue
    }
    if (CLOSERS[settings[i]!]) depth++
    else if (settings[i] === '}' || settings[i] === ']' || settings[i] === ')') depth--
    const word =
      settings.startsWith('include', i) &&
      !/[\w$.]/.test(settings[i - 1] ?? '') &&
      !/[\w$]/.test(settings[i + 7] ?? '')
    if (!word) {
      i++
      continue
    }
    const indent = /^[ \t]*/.exec(settings.slice(lineStart(settings, i)))![0]
    const paths: string[] = []
    const args = next(i + 7, false)
    if (args < 0) return undefined
    let end: number
    if (settings[args] === '(') {
      const close = matchClose(settings, args)
      if (close < 0) return undefined
      for (let k = args + 1; k < close; ) {
        const after = skip(settings, k)
        if (after < 0) return undefined
        if (after !== k && quoted(k)) paths.push(projectPath(settings.slice(k + 1, after - 1)))
        k = after === k ? k + 1 : after
      }
      end = close + 1
    } else if (quoted(args)) {
      let k = args
      while (true) {
        const after = skip(settings, k)
        if (after < 0) return undefined
        paths.push(projectPath(settings.slice(k + 1, after - 1)))
        end = after
        const comma = next(after, false)
        if (comma < 0) return undefined
        if (settings[comma] !== ',') break
        k = next(comma + 1, true)
        // A comma with no string after it: not a list this follows.
        if (k < 0 || !quoted(k)) return undefined
      }
    } else {
      i += 7
      continue
    }
    // What follows: the end of the line (or of the file), or more of the same expression.
    const rest = next(end, false)
    const ahead = rest < 0 ? -1 : next(rest, true)
    const ends =
      rest >= 0 &&
      (rest >= settings.length || settings[rest] === '\n') &&
      !/[.+\-*/%?:&|=,<>]/.test(settings[ahead] ?? '')
    const alone = settings.slice(lineStart(settings, i), i).trim() === ''
    out.push({ end, indent, paths, anchor: depth === 0 && alone && ends })
    i = end
  }
  return out
}

/**
 * Project paths named by `include` statements (Kotlin or Groovy), without the leading colon;
 * undefined when the file does not scan.
 */
export function includedProjects(settings: string): string[] | undefined {
  return includeStatements(lineEndings(settings).lf)?.flatMap((s) => s.paths)
}

/**
 * The lines `withInclude` adds: Kotlin syntax, or Groovy's for a settings.gradle. `dir` (relative
 * to the settings file) adds the `projectDir` line.
 */
export function includeLines(path: string, dir?: string, groovy = false): string[] {
  const name = projectPath(path)
  const q = (v: string) => (groovy ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v))
  return [
    groovy ? `include ${q(`:${name}`)}` : `include(${q(`:${name}`)})`,
    ...(dir ? [`project(${q(`:${name}`)}).projectDir = file(${q(dir)})`] : []),
  ]
}

/**
 * `settings` with the include after the last top-level include statement (or at the end of a file
 * with no includes);
 * undefined when the project is already included. `dir` adds a `projectDir` line: only needed when
 * the directory is not the path with `:` as `/`. `groovy`: the file is settings.gradle.
 * `'manual'` when the file does not scan, when its includes are all inside blocks or part of a
 * longer expression (`if (ci) { include(…) }`, `include ':a' +`), or when reading the result back does not give exactly
 * the projects it had plus this one (an include that opens a comment on its line, say).
 */
export function withInclude(
  settings: string,
  path: string,
  dir?: string,
  groovy = false,
): string | 'manual' | undefined {
  const { lf, restore } = lineEndings(settings)
  const name = projectPath(path)
  const statements = includeStatements(lf)
  if (!statements) return 'manual'
  const before = statements.flatMap((s) => s.paths)
  if (before.includes(name)) return undefined
  // The last include that is a top-level statement; with includes but none of those, there is no
  // line kit can add after without changing what the file does.
  const last = statements.findLast((s) => s.anchor)
  if (statements.length && !last) return 'manual'
  const lines = includeLines(name, dir, groovy)
  let out: string
  if (!last) {
    const base = lf === '' || lf.endsWith('\n') ? lf : `${lf}\n`
    out = `${base}${base.trim() === '' ? '' : '\n'}${lines.join('\n')}\n`
  } else {
    // After the statement's own line, so a trailing comment stays with it.
    const eol = lf.indexOf('\n', last.end)
    const at = eol < 0 ? lf.length : eol
    out = `${lf.slice(0, at)}\n${lines.map((l) => `${last.indent}${l}`).join('\n')}${lf.slice(at)}`
  }
  const after = includeStatements(out)?.flatMap((s) => s.paths)
  // Read back: the same projects in the same order, with the new one right after the anchor's.
  const at = last ? statements.indexOf(last) + 1 : 0
  const paths = (list: IncludeStatement[]) => list.flatMap((st) => st.paths)
  const expected = [...paths(statements.slice(0, at)), name, ...paths(statements.slice(at))]
  if (after?.join('\n') !== expected.join('\n')) return 'manual'
  return restore(out)
}
