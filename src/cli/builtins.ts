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
  // infra: env + db
  {
    path: ['env', 'sync'],
    description: 'Render env outputs (.dev.vars) from .env',
    group: 'Infra',
    load: () => import('../commands/env/sync'),
  },
  {
    path: ['env', 'check'],
    description: 'Validate .env and check outputs for drift',
    group: 'Infra',
    load: () => import('../commands/env/check'),
  },
  {
    path: ['env', 'push'],
    description: 'Push secrets with wrangler and gh',
    group: 'Infra',
    load: () => import('../commands/env/push'),
  },
  {
    path: ['env', 'init'],
    description: 'Create .env and ask for missing keys',
    group: 'Infra',
    load: () => import('../commands/env/init'),
  },
  {
    path: ['db', 'migrate'],
    description: 'Apply pending D1 migrations',
    group: 'Infra',
    load: () => import('../commands/db/migrate'),
  },
  {
    path: ['db', 'list'],
    description: 'List D1 migrations',
    group: 'Infra',
    load: () => import('../commands/db/list'),
  },
  {
    path: ['db', 'create'],
    description: 'Create a D1 migration',
    group: 'Infra',
    load: () => import('../commands/db/create'),
  },
  {
    path: ['db', 'exec'],
    description: 'Run SQL against D1',
    group: 'Infra',
    load: () => import('../commands/db/exec'),
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
  env: 'Render, check and push env from .env',
  db: 'Cloudflare D1 migrations and queries',
}
