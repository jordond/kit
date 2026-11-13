import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExitCode, KitError } from '../../src/lib/errors'
import { loadProject, localeText, localizeSlide, parseProject } from '../../src/lib/storeshots/project'
import type { ProjectV1 } from '../../src/lib/storeshots/types'

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'shots-app', 'brand', 'studio.json')
const fixture = (): Record<string, unknown> => JSON.parse(readFileSync(FIXTURE, 'utf8'))

const tmp = mkdtempSync(join(tmpdir(), 'kit-shots-project-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const save = (name: string, body: unknown): string => {
  const file = join(tmp, name)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}

async function rejected(promise: Promise<unknown>): Promise<KitError> {
  try {
    await promise
  } catch (e) {
    if (e instanceof KitError) return e
    throw e
  }
  throw new Error('did not throw')
}

describe('loadProject', () => {
  test('reads a version 1 project as it is saved', async () => {
    const project = (await loadProject(FIXTURE)) as ProjectV1
    expect(project).toEqual(fixture() as unknown as ProjectV1)
    expect(project.slides.map((s) => s.id)).toEqual(['slide-1', 'slide-2'])
    expect(project.locales?.['fr-FR']?.['slide-2']).toEqual({
      headline: 'Souvenez-vous de vos coups de cœur',
    })
  })

  test('keeps keys the editor adds later', async () => {
    const saved = fixture()
    const slides = saved.slides as Record<string, unknown>[]
    slides[0] = { ...slides[0], futureKey: { a: 1 } }
    const project = await loadProject(save('future.json', { ...saved, editor: 'next' }))
    expect(project).toEqual({ ...saved, editor: 'next' } as unknown as ProjectV1)
  })

  test('a project without locales, imageSrc, dimensionId or savedAt is valid', async () => {
    const { locales: _locales, dimensionId: _dimensionId, savedAt: _savedAt, ...saved } = fixture()
    const slides = (saved.slides as Record<string, unknown>[]).map(
      ({ imageSrc: _imageSrc, ...slide }) => slide,
    )
    const project = (await loadProject(save('bare.json', { ...saved, slides }))) as ProjectV1
    expect(project.locales).toBeUndefined()
    expect(project.slides[0]?.imageSrc).toBeUndefined()
  })

  // The project this format comes from; present on the machine that develops both, not in CI.
  const real = join(homedir(), 'dev', 'brewd', 'brand', 'screenshots', 'studio.json')
  test.skipIf(!existsSync(real))('reads the real brewd project unchanged', async () => {
    expect(await loadProject(real)).toEqual(JSON.parse(readFileSync(real, 'utf8')))
  })

  test('a missing file is a config error', async () => {
    const e = await rejected(loadProject(join(tmp, 'nope.json')))
    expect(e.exitCode).toBe(ExitCode.config)
    expect(e.message).toContain(join(tmp, 'nope.json'))
    expect(e.hint).toContain('shots.project')
  })

  test('a file that is not JSON is a config error', async () => {
    const e = await rejected(loadProject(save('broken.json', '{ "version": 1,')))
    expect(e.exitCode).toBe(ExitCode.config)
    expect(e.message).toContain('not JSON')
  })

  test('an invalid project names every bad field by its path', async () => {
    const saved = fixture()
    const slides = saved.slides as Record<string, Record<string, unknown>>[]
    slides[1] = { ...slides[1], device: { ...slides[1]!.device, frameType: 'flip-phone' } } as never
    delete (slides[0] as Record<string, unknown>).sourceFile
    const file = save('invalid.json', saved)
    const e = await rejected(loadProject(file))
    expect(e.exitCode).toBe(ExitCode.config)
    expect(e.message).toStartWith(`Invalid ${file}:`)
    expect(e.message).toContain('  slides.0.sourceFile: ')
    expect(e.message).toContain('  slides.1.device.frameType: ')
  })

  test('another version is refused', async () => {
    const e = await rejected(loadProject(save('v3.json', { ...fixture(), version: 3 })))
    expect(e.exitCode).toBe(ExitCode.config)
    expect(e.message).toContain('  version: ')
  })

  test('two slides cannot share an id', () => {
    const saved = fixture()
    const slides = saved.slides as Record<string, unknown>[]
    slides[1] = { ...slides[1], id: 'slide-1' }
    expect(() => parseProject({ ...saved, locales: undefined })).toThrow(
      'slides.1.id: Duplicate slide id "slide-1"',
    )
  })

  test('locales are strict: an unknown slide or field is refused', () => {
    expect(() => parseProject({ ...fixture(), locales: { de: { 'slide-9': { headline: 'x' } } } })).toThrow(
      'locales.de.slide-9: No slide has the id "slide-9"',
    )
    expect(() => parseProject({ ...fixture(), locales: { de: { 'slide-1': { headlin: 'x' } } } })).toThrow(
      'locales.de.slide-1',
    )
  })
})

describe('locale text', () => {
  const project = parseProject({
    ...fixture(),
    locales: {
      'fr-FR': { 'slide-1': { headline: 'Bonjour', badge: 'NOUVEAU' } },
      fr: { 'slide-1': { headline: 'Salut', subheadline: 'Sous-titre' } },
      'fr-CA': { 'slide-1': { headline: 'Allo' } },
      'pt-BR': { 'slide-2': { headline: 'Olá' } },
    },
  }) as ProjectV1
  const [first, second] = project.slides as [ProjectV1['slides'][0], ProjectV1['slides'][0]]

  test('the exact code wins', () => {
    expect(localeText(project, 'fr-CA', 'slide-1').headline).toBe('Allo')
    expect(localeText(project, 'fr', 'slide-1').headline).toBe('Salut')
  })

  test('then the first entry of the same language, in file order', () => {
    expect(localeText(project, 'fr-BE', 'slide-1')).toEqual({
      headline: 'Bonjour',
      subheadline: 'Sous-titre',
      badge: 'NOUVEAU',
    })
    expect(localeText(project, 'pt-PT', 'slide-2')).toEqual({ headline: 'Olá' })
  })

  test('a field the exact code leaves out falls through to the language', () => {
    expect(localeText(project, 'fr-CA', 'slide-1')).toEqual({
      headline: 'Allo',
      subheadline: 'Sous-titre',
      badge: 'NOUVEAU',
    })
  })

  test('then the base text of the slide', () => {
    expect(localeText(project, 'de-DE', 'slide-1')).toEqual({})
    expect(localeText(project, 'fr-FR', 'slide-2')).toEqual({})
    expect(localizeSlide(project, first, 'de-DE')).toBe(first)
    expect(localizeSlide(project, second, 'en-US')).toBe(second)
  })

  test('localizeSlide replaces the text and nothing else', () => {
    const slide = localizeSlide(project, first, 'fr-FR')
    expect(slide.headline).toEqual({ ...first.headline, text: 'Bonjour' })
    expect(slide.subheadline).toEqual({ ...first.subheadline, text: 'Sous-titre' })
    expect(slide.badge).toEqual({ ...first.badge, text: 'NOUVEAU' })
    expect({
      ...slide,
      headline: first.headline,
      subheadline: first.subheadline,
      badge: first.badge,
    }).toEqual(first)
    expect(first.headline.text).toBe('Everything in one place')
  })

  test('an empty string is a translation, not a gap', () => {
    const p = parseProject({ ...fixture(), locales: { ja: { 'slide-1': { subheadline: '' } } } }) as ProjectV1
    expect(localizeSlide(p, p.slides[0]!, 'ja').subheadline.text).toBe('')
  })
})
