import { accessSync, constants, statSync } from 'node:fs'
import { type KitContext, requireProject } from '../../cli/command'
import { CHROME_HINT, chromeBin } from '../chrome'
import { ExitCode, KitError } from '../errors'
import { emitJson } from '../log'
import { checkSources, type PageJob, planPages, type RenderedPage, renderPages } from './pages'

export interface PagesOptions {
  names: readonly string[]
  out: string | undefined
}

export interface PagesResult {
  dryRun: boolean
  pages: RenderedPage[]
}

/** The Chrome binary, checked to be a file kit can run. */
function requireChrome(): string {
  const chrome = chromeBin()
  try {
    if (!statSync(chrome).isFile()) throw new Error('not a file')
    accessSync(chrome, constants.X_OK)
  } catch {
    throw new KitError(`${chrome} is not a Chrome binary kit can run`, CHROME_HINT, ExitCode.precondition)
  }
  return chrome
}

const rel = (root: string, job: PageJob): RenderedPage => ({
  name: job.name,
  file: job.target.startsWith(`${root}/`) ? job.target.slice(root.length + 1) : job.target,
  width: job.width,
  height: job.height,
})

/** `kit shots pages`: render the pages, then report (or print the `--json` document). */
export async function runPages(ctx: KitContext, opts: PagesOptions): Promise<void> {
  const { root, config } = requireProject(ctx)
  const shots = config.shots
  if (!shots?.pages?.length) {
    throw new KitError(
      'No shots.pages in kit.config.ts',
      "Add shots: { pages: [{ name: 'header', file: 'art/header.html', width: 3840, height: 1646 }] }",
      ExitCode.config,
    )
  }
  const jobs = planPages(root, shots, opts.names, opts.out)
  checkSources(root, jobs)
  const dryRun = ctx.flags.dryRun
  let pages = jobs.map((job) => rel(root, job))
  if (!dryRun) {
    const chrome = requireChrome()
    pages = await renderPages(jobs, {
      chrome,
      root,
      shots,
      step: ctx.flags.json ? undefined : (message) => ctx.log.step(message),
      verbose: ctx.flags.verbose ? (message) => ctx.log.dim(message) : undefined,
    })
  }
  if (ctx.flags.json) {
    emitJson({ dryRun, pages } satisfies PagesResult)
    return
  }
  for (const page of pages) {
    ctx.log.info(`${page.name}: ${page.file} (${page.width}x${page.height})`)
  }
  const count = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`
  if (dryRun) ctx.log.info(`Dry run: ${count} would be written; Chrome was not started`)
  else ctx.log.success(`${count} written`)
}
