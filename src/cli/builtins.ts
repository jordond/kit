import type { Args } from 'gunshi'
import type { Group, KitCommand } from './command'

export interface BuiltinEntry {
  path: string[]
  description: string
  group: Group
  load: () => Promise<{ default: KitCommand<Args> }>
}

/** Static manifest: help can list built-ins without importing them. */
/** Static manifest: help can list built-ins without importing them. */
export const builtins: BuiltinEntry[] = [
  { path: ['dev'], description: 'Run a dev server', group: 'Develop', load: () => import('../commands/dev') },
  {
    path: ['build'],
    description: 'Build every target',
    group: 'Develop',
    load: () => import('../commands/build'),
  },
  {
    path: ['deploy'],
    description: 'Deploy a target',
    group: 'Develop',
    load: () => import('../commands/deploy'),
  },
  {
    path: ['lint'],
    description: 'Lint every target',
    group: 'Quality',
    load: () => import('../commands/lint'),
  },
  {
    path: ['format'],
    description: 'Format every target',
    group: 'Quality',
    load: () => import('../commands/format'),
  },
  {
    path: ['typecheck'],
    description: 'Typecheck every target',
    group: 'Quality',
    load: () => import('../commands/typecheck'),
  },
  {
    path: ['check'],
    description: 'Lint and typecheck every target',
    group: 'Quality',
    load: () => import('../commands/check'),
  },
  {
    path: ['test'],
    description: 'Run the test suites',
    group: 'Quality',
    load: () => import('../commands/test'),
  },
  {
    path: ['release', 'ios'],
    description: 'Build and upload iOS to a track',
    group: 'Release',
    load: () => import('../commands/release/ios'),
  },
  {
    path: ['release', 'android'],
    description: 'Build and upload Android to a track',
    group: 'Release',
    load: () => import('../commands/release/android'),
  },
  {
    path: ['config'],
    description: 'Print the resolved kit.config.ts',
    group: 'Setup',
    load: () => import('../commands/config'),
  },
]

export const groupDescriptions: Record<string, string> = {
  release: 'Ship to the stores',
}
