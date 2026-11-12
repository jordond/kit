import type { Args } from 'gunshi'
import type { Group, KitCommand } from './command'

export interface BuiltinEntry {
  path: string[]
  description: string
  group: Group
  load: () => Promise<{ default: KitCommand<Args> }>
}

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
    path: ['release', 'certs'],
    description: 'Install App Store signing with match; --add creates what is missing',
    group: 'Release',
    load: () => import('../commands/release/certs'),
  },
  {
    path: ['release', 'status'],
    description: 'Show the version and the latest build on each store track',
    group: 'Release',
    load: () => import('../commands/release/status'),
  },
  {
    path: ['release', 'promote'],
    description: 'Promote a build the store already has to a later track (no rebuild)',
    group: 'Release',
    load: () => import('../commands/release/promote'),
  },
  {
    path: ['release', 'rollout'],
    description: 'Change the production rollout: Play staged rollout, App Store phased release',
    group: 'Release',
    load: () => import('../commands/release/rollout'),
  },
  {
    path: ['release', 'metadata', 'pull'],
    description:
      'Download the store listing text into release.<platform>.metadata; --screenshots adds images',
    group: 'Release',
    load: () => import('../commands/release/metadata/pull'),
  },
  {
    path: ['release', 'metadata', 'push'],
    description: 'Upload the store listing text; --screenshots adds images. Never a binary or a review',
    group: 'Release',
    load: () => import('../commands/release/metadata/push'),
  },
  {
    path: ['version', 'show'],
    description: 'Show version names and last release tags',
    group: 'Release',
    load: () => import('../commands/version/show'),
  },
  {
    path: ['version', 'bump'],
    description: 'Bump a version name, commit and push',
    group: 'Release',
    load: () => import('../commands/version/bump'),
  },
  {
    path: ['fastlane'],
    description: "Run fastlane with kit's shared Fastfile",
    group: 'Release',
    load: () => import('../commands/fastlane'),
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
    path: ['env', 'rotate'],
    description: 'Generate a new value for a key and sync',
    group: 'Infra',
    load: () => import('../commands/env/rotate'),
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
  // setup: passthroughs, doctor, init, deps
  {
    path: ['gradle'],
    description: 'Run ./gradlew in the Gradle root',
    group: 'Develop',
    load: () => import('../commands/gradle'),
  },
  {
    path: ['kotlin'],
    description: 'Run the Kotlin toolchain wrapper in toolchain.root',
    group: 'Develop',
    load: () => import('../commands/kotlin'),
  },
  {
    path: ['wrangler'],
    description: "Run wrangler in a worker target's directory",
    group: 'Develop',
    load: () => import('../commands/wrangler'),
  },
  {
    path: ['xcode'],
    description: 'Open the iOS project in Xcode',
    group: 'Develop',
    load: () => import('../commands/xcode'),
  },
  {
    path: ['doctor'],
    description: 'Check tools, versions and .env',
    group: 'Setup',
    load: () => import('../commands/doctor'),
  },
  {
    path: ['init'],
    description: 'Set up a fresh clone, or add kit to a new repo',
    group: 'Setup',
    load: () => import('../commands/init'),
  },
  {
    path: ['deps'],
    description: 'List or update npm dependencies (catalog-aware)',
    group: 'Setup',
    load: () => import('../commands/deps'),
  },
  {
    path: ['upgrade'],
    description: 'Move the @jordond/kit pin and the workflow SHAs to a kit release',
    group: 'Setup',
    load: () => import('../commands/upgrade'),
  },
  // verb core
  {
    path: ['clean'],
    description: 'Remove build output',
    group: 'Develop',
    load: () => import('../commands/clean'),
  },
  // end setup
  {
    path: ['config'],
    description: 'Print the resolved kit.config.ts',
    group: 'Setup',
    load: () => import('../commands/config'),
  },
  {
    path: ['completion'],
    description: 'Print a shell completion script',
    group: 'Setup',
    load: () => import('../commands/completion'),
  },
]

export const groupDescriptions: Record<string, string> = {
  release: 'Ship to the stores',
  metadata: 'Sync the store listing (text, screenshots)',
  version: 'Version names in the catalog TOML',
  env: 'Render, check and push env from .env',
  db: 'Cloudflare D1 migrations and queries',
}
