import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Args } from 'gunshi'
import { KitError } from '../lib/errors'
import type { KitCommand } from './command'

export interface RepoCommandFile {
  /** Command path, e.g. ['whale', 'sfx'] for .kit/commands/whale/sfx.ts */
  path: string[]
  file: string
}

/** List repo command files. Glob only; nothing is imported. */
export function listRepoCommands(root: string): RepoCommandFile[] {
  const dir = join(root, '.kit', 'commands')
  const glob = new Bun.Glob('**/*.ts')
  const out: RepoCommandFile[] = []
  try {
    for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
      if (rel.endsWith('.d.ts') || rel.split('/').some((s) => s.startsWith('_'))) continue
      out.push({ path: rel.replace(/\.ts$/, '').split('/'), file: join(dir, rel) })
    }
  } catch {
    return []
  }
  return out.sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))
}

export async function importRepoCommand(f: RepoCommandFile): Promise<KitCommand<Args>> {
  const mod = await import(pathToFileURL(f.file).href)
  const cmd = mod.default as KitCommand<Args> | undefined
  if (!cmd || typeof cmd.run !== 'function') {
    throw new KitError(
      `${f.file} does not default-export a command`,
      'export default defineCommand({ description, run })',
    )
  }
  return cmd
}
