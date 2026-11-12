import { describe, expect, test } from 'bun:test'
import { bumpPin, parseTagSha, repinWorkflow, usesRef } from '../../src/lib/kitref'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('kit refs', () => {
  test('parseTagSha prefers the peeled commit of an annotated tag', () => {
    expect(parseTagSha(`${A}\trefs/tags/v1.2.3\n${B}\trefs/tags/v1.2.3^{}\n`, '1.2.3')).toBe(B)
    expect(parseTagSha(`${A}\trefs/tags/v1.2.3\n`, '1.2.3')).toBe(A)
    expect(parseTagSha(`${A}\trefs/tags/v1.2.30\n`, '1.2.3')).toBeUndefined()
    expect(parseTagSha('', '1.2.3')).toBeUndefined()
  })

  test('usesRef falls back to the tag', () => {
    expect(usesRef('1.2.3', A)).toBe(`${A} # v1.2.3`)
    expect(usesRef('1.2.3', undefined)).toBe('v1.2.3 # v1.2.3')
  })

  test('repinWorkflow moves every kit pin and nothing else', () => {
    const wf = [
      'steps:',
      '  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
      `  - uses: jordond/kit/.github/actions/setup@${A} # v0.5.0`,
      '    uses: jordond/kit/.github/workflows/mobile-distribute.yml@v0.5.0  # v0.5.0',
      '',
    ].join('\n')
    const out = repinWorkflow(wf, '0.6.0', B)
    expect(out.count).toBe(2)
    expect(out.text).toBe(
      [
        'steps:',
        '  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
        `  - uses: jordond/kit/.github/actions/setup@${B} # v0.6.0`,
        `    uses: jordond/kit/.github/workflows/mobile-distribute.yml@${B}  # v0.6.0`,
        '',
      ].join('\n'),
    )
    expect(repinWorkflow(out.text, '0.6.0', B)).toEqual({ text: out.text, count: 0 })
    expect(repinWorkflow('uses: jordond/kit/.github/actions/setup@main\n', '0.6.0', B).count).toBe(0)
  })

  test('bumpPin keeps the range operator and the formatting', () => {
    const pkg = '{\n  "devDependencies": {\n    "@jordond/kit": "^0.5.0",\n    "zod": "^4.0.0"\n  }\n}\n'
    expect(bumpPin(pkg, '0.6.0')).toEqual({
      text: pkg.replace('^0.5.0', '^0.6.0'),
      from: '^0.5.0',
      to: '^0.6.0',
    })
    expect(bumpPin('{"dependencies":{"@jordond/kit":"0.5.0"}}', '0.6.0')?.to).toBe('0.6.0')
    expect(bumpPin('{"dependencies":{"@jordond/kit":"~0.5.0"}}', '0.6.0')?.to).toBe('~0.6.0')
    expect(bumpPin(pkg, '0.5.0')?.text).toBe(pkg)
    expect(bumpPin('{"devDependencies":{"@jordond/kit":"file:../kit.tgz"}}', '0.6.0')).toMatchObject({
      from: 'file:../kit.tgz',
      to: 'file:../kit.tgz',
    })
    expect(bumpPin('{"devDependencies":{}}', '0.6.0')).toBeUndefined()
  })
})
