import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type KitContext, requireProject } from '../../cli/command'
import { onCleanup } from '../cleanup'
import type { DeviceTarget } from '../devices'
import { ExitCode, KitError } from '../errors'
import { runQuiet } from '../proc'
import { requireShots, resolveRawDir, runExport, storeLocales } from './command'
import { pageAssets, repoPath } from './plan'
import { BUILT_IN_STYLE } from './resolve'
import { resolveSets, SET_SIZES, STORE_TARGETS, storeOf } from './sizes'
import type { StudioSession } from './studio-api'
import { serveStudio } from './studio-server'

/** Where the built editor is: `dist/shots-editor`, next to the CLI chunks; in a source checkout, `<repo>/dist/shots-editor`. */
export function editorDir(): string | undefined {
  const candidates = [
    join(import.meta.dir, 'shots-editor'),
    join(import.meta.dir, '..', '..', '..', 'dist', 'shots-editor'),
  ]
  return candidates.find((dir) => existsSync(join(dir, 'index.html')))
}

/** The browser opener of this platform. A failure is not an error: the URL is printed. */
async function openBrowser(url: string): Promise<boolean> {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  const result = await runQuiet(cmd).catch(() => ({ code: 127, output: '' }))
  return result.code === 0
}

/** `kit shots studio`: serve the editor and its API for the repo's project until interrupted. */
export async function studioShots(ctx: KitContext, opts: { port?: number; open: boolean }): Promise<void> {
  const { root, config } = requireProject(ctx)
  const shots = requireShots(config)
  const rawDir = resolveRawDir(root, config, shots)
  const { fonts, brand, assets } = pageAssets(root, shots)
  const sets = resolveSets(config)
  const sizes = {} as StudioSession['sets']
  for (const store of ['apple', 'google'] as const) {
    for (const target of STORE_TARGETS[store] as readonly DeviceTarget[]) {
      sizes[target] = { id: sets[target], store: storeOf(target), ...SET_SIZES[sets[target]] }
    }
  }
  const session: StudioSession = {
    projectPath: repoPath(root, resolve(root, shots.project)),
    rawPath: repoPath(root, rawDir),
    targets: ['ios', 'ipad', 'android'],
    sets: sizes,
    locales: storeLocales(root, config),
    // `pageAssets` numbers the files as the export page fetches them (`asset/<n>`); here they sit under `api/`.
    fonts: fonts.map((font) => ({ ...font, url: `api/${font.url}` })),
    brand: brand ? { ...brand, mark: `api/${brand.mark}` } : null,
    builtIn: BUILT_IN_STYLE,
  }

  let server: ReturnType<typeof serveStudio>
  try {
    server = serveStudio({
      session,
      projectFile: resolve(root, shots.project),
      rawDir,
      assets,
      editorDir: editorDir(),
      port: opts.port,
      runExport: (request) =>
        runExport(
          root,
          config,
          { stores: request.stores, locales: request.locales, allowMissing: false, force: false },
          { dryRun: false, verbose: ctx.flags.verbose ? (message) => ctx.log.dim(message) : undefined },
        ),
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new KitError(
      `Could not start the studio${opts.port === undefined ? '' : ` on port ${opts.port}`}: ${reason}`,
      opts.port === undefined ? undefined : 'Pick another --port, or leave it out',
      ExitCode.precondition,
    )
  }
  onCleanup(() => server.stop())

  ctx.log.success(`kit shots studio: ${server.url}`)
  if (!editorDir()) {
    ctx.log.warn('The editor is not built, so the page is a placeholder; the API works')
    ctx.log.info('  build it with `bun run build` in a kit checkout, or reinstall kit')
  }
  ctx.log.info('  press Ctrl-C to stop')
  if (opts.open) {
    if (!(await openBrowser(server.url))) ctx.log.warn(`Could not open a browser; open ${server.url}`)
  }
  await new Promise<never>(() => {})
}
