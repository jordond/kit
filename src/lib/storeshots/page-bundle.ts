import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { KitError } from '../errors'
import type { PageBundle } from './types'

/** The file `bun run build` emits next to the CLI chunks. */
const BUILT = 'shots-page.js'

/**
 * The page JS headless Chrome runs, served as `page.js`. A built kit ships it as
 * `dist/shots-page.js`, next to the chunk this code is bundled into; a source checkout has no such
 * file and bundles `page/main.ts` on the spot.
 */
export const pageBundle: PageBundle = async () => {
  const built = join(import.meta.dir, BUILT)
  if (existsSync(built)) return Bun.file(built).text()

  const entry = join(import.meta.dir, 'page', 'main.ts')
  if (!existsSync(entry)) {
    throw new KitError(`The shots page is missing: ${built}`, 'Reinstall kit, or run `bun run build` in it')
  }
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', throw: false })
  const output = result.outputs[0]
  if (!result.success || !output) {
    const logs = result.logs.map((log) => log.message).join('\n')
    throw new KitError(`Could not bundle the shots page${logs ? `:\n${logs}` : ''}`)
  }
  return output.text()
}
