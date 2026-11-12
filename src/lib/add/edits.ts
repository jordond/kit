/**
 * Surgical text edits for `kit add`: one more `include` in settings.gradle.kts, one more module in
 * project.yaml, one more target in kit.config.ts. Each keeps the file's ordering, comments,
 * formatting and line endings, is a no-op when the entry is already there, and gives up (`manual`)
 * on a shape it does not recognise instead of guessing. Every edit is read back: it stands only
 * when the new text parses to what was there plus the one entry. Pure: text in, text out.
 */

// ---- line endings -----------------------------------------------------------------------------

/**
 * Edits work on LF text. A file that is CRLF throughout is converted for the edit and back after,
 * so inserted lines end the way the file's do; mixed endings are left as they are.
 */
function lineEndings(text: string): { lf: string; restore: (edited: string) => string } {
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text)
  if (!crlf) return { lf: text, restore: (edited) => edited }
  return { lf: text.replace(/\r\n/g, '\n'), restore: (edited) => edited.replace(/\n/g, '\r\n') }
}

// ---- settings.gradle(.kts) --------------------------------------------------------------------

const projectPath = (s: string) => s.replace(/^:/, '')

interface IncludeStatement {
  /** Just past the statement's last character (the `)` or the last string). */
  end: number
  indent: string
  paths: string[]
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
  for (let i = 0; i < settings.length; ) {
    const j = skip(settings, i)
    if (j < 0) return undefined
    if (j !== i) {
      i = j
      continue
    }
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
    out.push({ end, indent, paths })
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
 * `settings` with the include after the last include statement (or at the end of the file);
 * undefined when the project is already included. `dir` adds a `projectDir` line: only needed when
 * the directory is not the path with `:` as `/`. `groovy`: the file is settings.gradle.
 * `'manual'` when the file does not scan, or when reading the result back does not give exactly
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
  const last = statements.at(-1)
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
  if (after?.join('\n') !== [...before, name].join('\n')) return 'manual'
  return restore(out)
}

// ---- project.yaml -----------------------------------------------------------------------------

const cleanEntry = (raw: string) =>
  raw
    .trim()
    .replace(/\s+#.*$/, '')
    .replace(/^(['"])(.*)\1$/, '$2')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')

const covers = (entry: string, dir: string) =>
  entry === dir || (/[*?{]/.test(entry) && new Bun.Glob(entry).match(dir))

/** The text edit of `withProjectModule`, and the entry as written. */
function editProjectModule(
  projectYaml: string,
  dir: string,
): { out: string; entry: string } | 'manual' | undefined {
  const lines = projectYaml.split('\n')
  const start = lines.findIndex((l) => /^modules\s*:/.test(l))
  if (start < 0) {
    const base = projectYaml === '' || projectYaml.endsWith('\n') ? projectYaml : `${projectYaml}\n`
    return { out: `${base}${base.trim() === '' ? '' : '\n'}modules:\n  - ${dir}\n`, entry: dir }
  }
  const head = lines[start]!
  const flow = head.match(/^(modules\s*:\s*\[)(.*?)(\]\s*(?:#.*)?)$/)
  if (flow) {
    const entries = flow[2]!.split(',').filter((e) => e.trim() !== '')
    if (entries.map(cleanEntry).some((e) => covers(e, dir))) return undefined
    const dot = entries.length > 0 && entries.every((e) => e.trim().replace(/^['"]/, '').startsWith('./'))
    const inner = flow[2]!.trimEnd()
    const entry = `${dot ? './' : ''}${dir}`
    lines[start] = `${flow[1]}${inner}${entries.length ? ', ' : ''}${entry}${flow[3]}`
    return { out: lines.join('\n'), entry }
  }
  if (!/^modules\s*:\s*(#.*)?$/.test(head)) return 'manual'
  let last = start
  let indent = '  '
  const entries: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const m = line.match(/^(\s*)-\s*(.+?)\s*$/)
    if (!m) break
    indent = m[1]!
    entries.push(m[2]!)
    last = i
  }
  if (entries.map(cleanEntry).some((e) => covers(e, dir))) return undefined
  const dot = entries.length > 0 && entries.every((e) => e.replace(/^['"]/, '').startsWith('./'))
  const entry = `${dot ? './' : ''}${dir}`
  lines.splice(last + 1, 0, `${indent}- ${entry}`)
  return { out: lines.join('\n'), entry }
}

/** `modules` as a YAML parser reads it; undefined when the file does not parse or it is not a list. */
function yamlModules(projectYaml: string): unknown[] | undefined {
  try {
    const doc = Bun.YAML.parse(projectYaml) as { modules?: unknown } | null
    const modules = doc?.modules ?? []
    return Array.isArray(modules) ? modules : undefined
  } catch {
    return undefined
  }
}

/**
 * project.yaml with `dir` added to `modules:` in the list's own style (block or one-line flow,
 * `./` prefix or not); undefined when it is already listed or matched by a glob entry; `'manual'`
 * when `modules` is written another way (a multi-line flow list, a scalar), or when a YAML parser
 * does not read the result as the same list plus this entry.
 */
export function withProjectModule(projectYaml: string, dir: string): string | 'manual' | undefined {
  const { lf, restore } = lineEndings(projectYaml)
  const edit = editProjectModule(lf, dir)
  if (edit === undefined || edit === 'manual') return edit
  const before = yamlModules(lf)
  const after = yamlModules(edit.out)
  if (!before || JSON.stringify(after) !== JSON.stringify([...before, edit.entry])) return 'manual'
  return restore(edit.out)
}

// ---- kit.config.ts ----------------------------------------------------------------------------

/**
 * Index just past the string or comment starting at `i`; `i` when none starts there; -1 for what
 * this scanner does not follow (a template literal with `${}`, an unterminated string or comment).
 */
function skip(text: string, i: number): number {
  const c = text[i]
  if (c === '/' && text[i + 1] === '/') {
    const end = text.indexOf('\n', i)
    return end < 0 ? text.length : end
  }
  if (c === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2)
    return end < 0 ? -1 : end + 2
  }
  if (c === "'" || c === '"' || c === '`') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === c) return j + 1
      else if (c === '`' ? text[j] === '$' && text[j + 1] === '{' : text[j] === '\n') return -1
    }
    return -1
  }
  return i
}

const CLOSERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

/** Index of the bracket closing the one at `open`; -1 when the text does not balance. */
function matchClose(text: string, open: number): number {
  const stack: string[] = []
  for (let i = open; i < text.length; ) {
    const j = skip(text, i)
    if (j < 0) return -1
    if (j !== i) {
      i = j
      continue
    }
    const c = text[i]!
    if (CLOSERS[c]) stack.push(CLOSERS[c])
    else if (c === '}' || c === ']' || c === ')') {
      if (stack.pop() !== c) return -1
      if (!stack.length) return i
    }
    i++
  }
  return -1
}

interface Property {
  name: string
  /** Index of the key's first character. */
  start: number
  valueStart: number
  /** Just past the value's last significant character. */
  valueEnd: number
}

interface ObjectShape {
  open: number
  close: number
  properties: Property[]
  /** Last character that is not whitespace or a comment before `close`; `open` in an empty object. */
  last: number
}

/**
 * The plain `key: value` properties of the object literal at `open`. Undefined for anything else
 * in there (a spread, a computed or shorthand key, a method): not a shape to edit by text.
 */
function readObject(text: string, open: number): ObjectShape | undefined {
  const close = matchClose(text, open)
  if (text[open] !== '{' || close < 0) return undefined
  const properties: Property[] = []
  let last = open
  /** Next significant index at or after `i`. */
  const next = (i: number): number => {
    while (i < close) {
      const j = skip(text, i)
      if (j < 0) return -1
      if (j !== i && text[i] === '/') i = j
      else if (/\s/.test(text[i]!)) i++
      else return i
    }
    return close
  }
  let i = next(open + 1)
  while (i >= 0 && i < close) {
    const start = i
    let name: string
    let afterKey: number
    if (text[i] === "'" || text[i] === '"') {
      afterKey = skip(text, i)
      if (afterKey < 0) return undefined
      name = text.slice(i + 1, afterKey - 1)
    } else {
      const id = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, close))
      if (!id) return undefined
      name = id[0]
      afterKey = i + name.length
    }
    const colon = next(afterKey)
    if (colon < 0 || text[colon] !== ':') return undefined
    const valueStart = next(colon + 1)
    if (valueStart < 0 || valueStart >= close) return undefined
    // The value runs to the next comma at this depth, or to the closing brace.
    let j = valueStart
    let valueEnd = valueStart
    while (j < close && text[j] !== ',') {
      if (CLOSERS[text[j]!]) {
        const end = matchClose(text, j)
        if (end < 0) return undefined
        j = end + 1
        valueEnd = j
        continue
      }
      const k = skip(text, j)
      if (k < 0) return undefined
      if (k !== j) {
        if (text[j] !== '/') valueEnd = k
        j = k
        continue
      }
      if (!/\s/.test(text[j]!)) valueEnd = j + 1
      j++
    }
    properties.push({ name, start, valueStart, valueEnd })
    last = j < close ? j : valueEnd - 1
    i = j < close ? next(j + 1) : close
  }
  if (i < 0) return undefined
  return { open, close, properties, last }
}

const lineStart = (text: string, i: number) => text.lastIndexOf('\n', i - 1) + 1
const indentOf = (text: string, i: number) => /^[ \t]*/.exec(text.slice(lineStart(text, i)))![0]

/**
 * `text` with a property appended to the object: on its own line when the closing brace has one,
 * else inline. `render(indent, unit)` gets the property's indent and one indent step ('' inline).
 * Undefined when a comment sits between the last property and an inline closing brace.
 */
function appendProperty(
  text: string,
  shape: ObjectShape,
  render: (indent: string | undefined, unit: string) => string,
): string | undefined {
  const { open, close, last, properties } = shape
  const comma = last !== open && text[last] !== ',' ? ',' : ''
  const closeLine = lineStart(text, close)
  if (closeLine > open && text.slice(closeLine, close).trim() === '') {
    const closeIndent = text.slice(closeLine, close)
    const first = properties[0]
    const own = first && lineStart(text, first.start) > open ? indentOf(text, first.start) : undefined
    const indent = own !== undefined && own.length > closeIndent.length ? own : `${closeIndent}  `
    const unit = indent.slice(closeIndent.length)
    return `${text.slice(0, last + 1)}${comma}${text.slice(last + 1, closeLine)}${indent}${render(indent, unit)},\n${text.slice(closeLine)}`
  }
  if (text.slice(last + 1, close).trim() !== '') return undefined
  const inner = text.slice(open + 1, close)
  const pad = inner.trim() === '' || /^\s/.test(inner) ? ' ' : ''
  const lead = last === open ? pad : ' '
  return `${text.slice(0, last + 1)}${comma}${lead}${render(undefined, '')}${pad}${text.slice(close)}`
}

/** The object literal `export default` evaluates to: bare, or the argument of `defineConfig(`. */
function configObject(text: string): ObjectShape | undefined {
  for (let i = 0; i < text.length; ) {
    const j = skip(text, i)
    if (j < 0) return undefined
    if (j !== i) {
      i = j
      continue
    }
    if (text.startsWith('export default', i) && !/[\w$]/.test(text[i - 1] ?? '')) {
      const head = /^export\s+default\s+(?:defineConfig\s*\(\s*)?/.exec(text.slice(i))
      if (!head || text[i + head[0].length] !== '{') return undefined
      return readObject(text, i + head[0].length)
    }
    i++
  }
  return undefined
}

function targetsObject(text: string, config: ObjectShape): ObjectShape | 'none' | undefined {
  const found = config.properties.filter((p) => p.name === 'targets')
  if (!found.length) return 'none'
  const [prop] = found
  if (found.length > 1 || !prop || text[prop.valueStart] !== '{') return undefined
  const shape = readObject(text, prop.valueStart)
  // `{ … } as const`, `{ … } satisfies X`: not a plain literal.
  return shape && shape.close + 1 === prop.valueEnd ? shape : undefined
}

/** Target names in the config's `targets: { … }` literal; undefined when the file is not that shape. */
export function configTargets(source: string): string[] | undefined {
  const text = lineEndings(source).lf
  const config = configObject(text)
  const targets = config && targetsObject(text, config)
  if (!targets) return undefined
  return targets === 'none' ? [] : targets.properties.map((p) => p.name)
}

export interface TargetEntry {
  kind: string
  dir: string
}

/** `api: { kind: 'worker', dir: 'apps/api' }`, quoted the way `like` quotes its strings. */
export function targetSnippet(name: string, entry: TargetEntry, like = ''): string {
  const double = like.includes('"') && !like.includes("'")
  const q = (s: string) => (double ? JSON.stringify(s) : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
  const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : q(name)
  return `${key}: { kind: ${q(entry.kind)}, dir: ${q(entry.dir)} }`
}

export type TargetEdit =
  | { status: 'edited'; content: string }
  | { status: 'exists' }
  /** The file is not a shape kit edits; `snippet` is what to paste into `targets: { … }`. */
  | { status: 'manual'; snippet: string }

/**
 * kit.config.ts with the target appended to its `targets: { … }` object (created as the config's
 * last property when there is none). Only a config written as `export default {…}` or
 * `export default defineConfig({…})` with plain `key: value` properties is edited.
 */
export function withTarget(source: string, name: string, entry: TargetEntry): TargetEdit {
  const { lf: text, restore } = lineEndings(source)
  const snippet = targetSnippet(name, entry, text)
  const manual: TargetEdit = { status: 'manual', snippet: `${snippet},` }
  const config = configObject(text)
  if (!config) return manual
  const targets = targetsObject(text, config)
  if (!targets) return manual
  if (targets !== 'none' && targets.properties.some((p) => p.name === name)) return { status: 'exists' }
  const content =
    targets === 'none'
      ? appendProperty(text, config, (indent, unit) =>
          indent === undefined
            ? `targets: { ${snippet} }`
            : `targets: {\n${indent}${unit}${snippet},\n${indent}}`,
        )
      : appendProperty(text, targets, () => snippet)
  // Read the result back: the edit stands only if the new file has the same targets plus this one.
  const before = targets === 'none' ? [] : targets.properties.map((p) => p.name)
  const after = content === undefined ? undefined : configTargets(content)
  if (content === undefined || after?.join('\n') !== [...before, name].join('\n')) return manual
  return { status: 'edited', content: restore(content) }
}
