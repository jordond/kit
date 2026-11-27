import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema } from '../../src/config/schema'
import { KitError } from '../../src/lib/errors'
import { servePages, withContext } from '../../src/lib/storeshots/pages'
import { planSlides, type SlidePlanInput, shotFile } from '../../src/lib/storeshots/slides'
import type { StoreDestination } from '../../src/lib/storeshots/types'

/** `shots.slides`: the plan of an export of HTML slides, the config rules, and what the page is told. */

const ROOT = '/repo'
const destinations: StoreDestination[] = [
  { store: 'apple', dir: '/repo/fastlane/screenshots', locales: ['en-US'] },
  { store: 'google', dir: '/repo/fastlane/metadata/android', locales: ['en-US'] },
]
const slides = [
  { name: 'shelf', file: 'brand/store/01.html', shot: '01-shelf', background: '#ffd400' },
  { name: 'Now.Playing', file: 'brand/store/02.html', shot: 'playing.png' },
  { name: 'outro', file: 'brand/store/03.html' },
]
const raw = (targets: string[], files: string[]) =>
  new Set(targets.flatMap((t) => files.map((f) => `${t}/${f}`)))
const input = (over: Partial<SlidePlanInput> = {}): SlidePlanInput => ({
  root: ROOT,
  config: { shots: { slides } } as never,
  destinations,
  rawDir: '/repo/maestro/screenshots',
  raw: raw(['ios', 'ipad', 'android'], ['01-shelf.png', 'playing.png']),
  allowMissing: false,
  ...over,
})

describe('planSlides', () => {
  test('every slide for every set, at the set size, under the export file names', () => {
    const plan = planSlides(input())
    expect(plan.jobs.map((j) => j.file.slice(ROOT.length + 1))).toEqual([
      'fastlane/screenshots/en-US/01_iphone-6.9_shelf.png',
      'fastlane/screenshots/en-US/02_iphone-6.9_now-playing.png',
      'fastlane/screenshots/en-US/03_iphone-6.9_outro.png',
      'fastlane/screenshots/en-US/01_ipad-13_shelf.png',
      'fastlane/screenshots/en-US/02_ipad-13_now-playing.png',
      'fastlane/screenshots/en-US/03_ipad-13_outro.png',
      'fastlane/metadata/android/en-US/images/phoneScreenshots/01_shelf.png',
      'fastlane/metadata/android/en-US/images/phoneScreenshots/02_now-playing.png',
      'fastlane/metadata/android/en-US/images/phoneScreenshots/03_outro.png',
    ])
    const sizes = new Map(plan.jobs.map((j) => [j.set, `${j.width}x${j.height}@${j.scale}`]))
    expect(Object.fromEntries(sizes)).toEqual({
      'iphone-6.9': '1320x2868@2',
      'ipad-13': '2064x2752@4',
      phone: '1440x2560@2',
    })
    expect(plan.jobs[0]).toMatchObject({
      id: 'ios-en-US-01',
      source: '/repo/brand/store/01.html',
      background: '#ffd400',
      label: 'slide shelf (iphone-6.9, en-US)',
      context: {
        set: 'iphone-6.9',
        target: 'ios',
        store: 'apple',
        locale: 'en-US',
        slide: 'shelf',
        index: 1,
        shot: '/repo/maestro/screenshots/ios/01-shelf.png',
      },
    })
    expect(plan.jobs[2]!.context).not.toHaveProperty('shot')
    expect(plan.jobs[2]!.background).toBe('#ffffff')
  })

  test('a shot under the locale dir wins over the shared one', () => {
    const files = raw(['ios', 'ipad', 'android'], ['01-shelf.png', 'playing.png']).add(
      'ios/en-US/01-shelf.png',
    )
    const plan = planSlides(input({ raw: files }))
    expect(plan.jobs[0]!.context!.shot).toBe('/repo/maestro/screenshots/ios/en-US/01-shelf.png')
    expect(plan.jobs[3]!.context!.shot).toBe('/repo/maestro/screenshots/ipad/01-shelf.png')
  })

  test('a missing raw shot stops the plan and names the capture command', () => {
    const files = raw(['ios', 'android'], ['01-shelf.png', 'playing.png'])
    let error: KitError | undefined
    try {
      planSlides(input({ raw: files }))
    } catch (e) {
      error = e as KitError
    }
    expect(error?.message).toContain('maestro/screenshots/ipad/01-shelf.png')
    expect(error?.hint).toContain('`kit shots ipad`')
    expect(error?.exitCode).toBe(4)
  })

  test('--allow-missing skips the slide and moves the later ones up', () => {
    const files = raw(['ios', 'ipad', 'android'], ['playing.png'])
    const plan = planSlides(input({ raw: files, allowMissing: true, destinations: [destinations[1]!] }))
    expect(plan.skipped).toEqual([
      {
        store: 'google',
        target: 'android',
        set: 'phone',
        locale: 'en-US',
        slide: 'shelf',
        shot: 'maestro/screenshots/android/01-shelf.png',
      },
    ])
    expect(plan.jobs.map((j) => j.file.split('/').at(-1))).toEqual(['01_now-playing.png', '02_outro.png'])
  })

  test('shotFile adds .png to a name without an extension', () => {
    expect(shotFile('01-shelf')).toBe('01-shelf.png')
    expect(shotFile('a.jpg')).toBe('a.jpg')
  })
})

describe('shots.slides in the config', () => {
  const parse = (shots: object, maestro: object | undefined = { dir: 'maestro' }) =>
    configSchema.safeParse({ name: 'x', targets: {}, maestro, shots })
  const messages = (shots: object, maestro?: object) =>
    parse(shots, maestro).error?.issues.map((i) => i.message) ?? []

  test('slides alone are a shots block', () => {
    expect(parse({ slides }).success).toBe(true)
  })

  test('project and slides together are an error', () => {
    expect(messages({ project: 'p.json', slides }).join()).toContain(
      'shots.project and shots.slides are both set',
    )
  })

  test('duplicate names, a shot path and an unknown suite are rejected', () => {
    expect(messages({ slides: [slides[0], slides[0]] })).toContain('Duplicate slide "shelf"')
    expect(messages({ slides: [{ ...slides[0], shot: 'ios/a.png' }] }).join()).toContain('not a path')
    expect(messages({ slides, suites: ['shots', 'nope'] })).toContain('Unknown suite "nope"')
    expect(parse({ slides, suites: ['shots', 'qa'] }).success).toBe(true)
    const bare = configSchema.safeParse({
      name: 'x',
      targets: {},
      shots: { pages: [{ name: 'p', file: 'p.html', width: 1000, height: 500 }], suites: ['shots'] },
    })
    expect(bare.error?.issues.map((i) => i.message)).toContain(
      'shots.suites names maestro suites, and there is no maestro block',
    )
  })
})

describe('what the page is told', () => {
  let root: string
  let server: ReturnType<typeof servePages>
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-slides-unit-')))
    mkdirSync(join(root, 'brand'))
    mkdirSync(join(root, '.raw'))
    writeFileSync(
      join(root, 'brand/slide.html'),
      '<!doctype html><html><head><title>s</title></head><body><img class="a" data-kit-shot src="../raw/ios/x.png" srcset="y 2x"><img src="keep.png"></body></html>',
    )
    writeFileSync(join(root, '.raw/shot.v2-final'), 'PNG')
    server = servePages(root, {} as never)
  })
  afterAll(async () => {
    await server.stop()
    rmSync(root, { recursive: true, force: true })
  })

  test('a slide request gets data-kit attributes, --kit-shot and the img src', async () => {
    const shot = server.expose(join(root, '.raw/shot.v2-final'))
    expect(shot).toMatch(/\/__kit\/shot\/\d+$/)
    const query = new URLSearchParams({
      set: 'ipad-13',
      target: 'ipad',
      store: 'apple',
      locale: 'en-US',
      slide: 'shelf',
      index: '2',
      shot,
    })
    const html = await (await fetch(`${server.url}brand/slide.html?${query}`)).text()
    expect(html).toContain(`<style>:root{--kit-shot:url("${shot}")}</style>`)
    expect(html).toContain(
      `"kitSet":"ipad-13","kitTarget":"ipad","kitStore":"apple","kitLocale":"en-US","kitSlide":"shelf","kitIndex":"2","kitShot":"${shot}"`,
    )
    expect(html).toContain(`<img src="${shot}" class="a" data-kit-shot>`)
    expect(html).toContain('<img src="keep.png">')
    // The injection sits in <head>, before the page's own markup.
    expect(html.indexOf('kitSet')).toBeLessThan(html.indexOf('<title>'))
    // The raw shot is served though it sits under a dot dir, which the repo routes refuse.
    const served = await fetch(new URL(shot, server.url))
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('PNG')
    expect((await fetch(`${server.url}.raw/shot.v2-final`)).status).toBe(404)
    expect((await fetch(`${server.url}__kit/shot/99`)).status).toBe(404)
    expect((await fetch(`${server.url}__kit/shot/../../.raw/shot.v2-final`)).status).toBe(404)
  })

  test('a shot URL the server did not make is not put into the page', async () => {
    const query = new URLSearchParams({ set: 'phone', shot: '"><script>alert(1)</script>' })
    const html = await (await fetch(`${server.url}brand/slide.html?${query}`)).text()
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('src="../raw/ios/x.png"')
  })

  test('a page without the query is not told anything, but reports its viewport', async () => {
    const html = await (await fetch(`${server.url}brand/slide.html`)).text()
    expect(html).not.toContain('kitSet')
    expect(html).toContain('__kit/viewport')
    server.forgetViewport()
    expect(server.viewport()).toBeUndefined()
    await fetch(`${server.url}__kit/viewport?w=720&h=1280`)
    expect(server.viewport()).toEqual({ width: 720, height: 1280 })
    expect(server.requests.some((r) => r.path.startsWith('__kit/viewport'))).toBe(false)
  })

  test('only an img with the data-kit-shot attribute itself is filled', () => {
    const html = withContext(
      '<html><head></head><img data-kit-shot-size="2" src="a.png"><img data-kit-shot="" src=b.png></html>',
      new URLSearchParams({ set: 'phone' }),
      '/t/__kit/shot/0',
    )
    expect(html).toContain('<img data-kit-shot-size="2" src="a.png">')
    expect(html).toContain('<img src="/t/__kit/shot/0" data-kit-shot="">')
  })

  test('withContext escapes a value that would end the script', () => {
    const html = withContext(
      '<html><head></head></html>',
      new URLSearchParams({ set: '</script>' }),
      undefined,
    )
    expect(html).not.toContain('</script>"')
    expect(html).toContain('\\u003c/script>')
  })
})
