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
  {
    path: ['changelog'],
    description: 'List the changes since the last release tag',
    group: 'Release',
    load: () => import('../commands/changelog'),
  },
  // devices: app build/install/run, device list/boot/statusbar
  {
    path: ['app', 'build'],
    description: 'Build the debug app for a platform and print the artifact path',
    group: 'Develop',
    load: () => import('../commands/app/build'),
  },
  {
    path: ['app', 'install'],
    description: 'Build and install the app on a device, simulator or emulator',
    group: 'Develop',
    load: () => import('../commands/app/install'),
  },
  {
    path: ['app', 'run'],
    description: 'Build, install and launch the app',
    group: 'Develop',
    load: () => import('../commands/app/run'),
  },
  {
    path: ['app', 'uninstall'],
    description: 'Remove the app from a device',
    group: 'Develop',
    load: () => import('../commands/app/uninstall'),
  },
  {
    path: ['app', 'clear'],
    description: "Wipe the app's data on a device",
    group: 'Develop',
    load: () => import('../commands/app/clear'),
  },
  {
    path: ['device', 'list'],
    description: 'List simulators, emulators and connected devices',
    group: 'Develop',
    load: () => import('../commands/device/list'),
  },
  {
    path: ['device', 'boot'],
    description: 'Boot a simulator or emulator, creating one when none exists',
    group: 'Develop',
    load: () => import('../commands/device/boot'),
  },
  {
    path: ['device', 'statusbar'],
    description: 'Pin the status bar to 9:41 with full signal and battery; --clear restores it',
    group: 'Develop',
    load: () => import('../commands/device/statusbar'),
  },
  // end devices
  // maestro: qa, shots, maestro passthrough, fixture load/dump
  {
    path: ['qa'],
    description: 'Run the Maestro flows on a device: build, install, fixture, flows',
    group: 'Quality',
    load: () => import('../commands/qa'),
  },
  {
    path: ['shots'],
    description: 'Capture screenshots with the Maestro flows: 9:41 status bar, fixture, PNGs',
    group: 'Quality',
    load: () => import('../commands/shots'),
  },
  {
    path: ['shots', 'export'],
    description: 'Render the store screenshots from the raw shots and the saved project',
    group: 'Quality',
    load: () => import('../commands/shots/export'),
  },
  {
    path: ['shots', 'pages'],
    description: 'Render the HTML artwork pages in shots.pages to PNGs, without alpha',
    group: 'Quality',
    load: () => import('../commands/shots/pages'),
  },
  {
    path: ['shots', 'migrate'],
    description: 'Rewrite the saved shots project as a version 2 project (rules once, sparse slides)',
    group: 'Quality',
    load: () => import('../commands/shots/migrate'),
  },
  {
    path: ['shots', 'studio'],
    description: 'Edit the shots project in a browser: slides, styles, a live preview, export',
    group: 'Quality',
    load: () => import('../commands/shots/studio'),
  },
  {
    path: ['maestro'],
    description: 'Run the Maestro CLI (arguments pass through)',
    group: 'Develop',
    load: () => import('../commands/maestro'),
  },
  {
    path: ['fixture', 'load'],
    description: 'Replay a fixture (app state) onto a device',
    group: 'Develop',
    load: () => import('../commands/fixture/load'),
  },
  {
    path: ['fixture', 'dump'],
    description: "Capture the app's state from a device into a fixture",
    group: 'Develop',
    load: () => import('../commands/fixture/dump'),
  },
  // end maestro
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
  // cloudflare workers: db backup/restore/seed/reset, logs, open, release rollback
  {
    path: ['db', 'backup'],
    description: 'Export a D1 database to a .sql file',
    group: 'Infra',
    load: () => import('../commands/db/backup'),
  },
  {
    path: ['db', 'restore'],
    description: 'Run a .sql backup against D1',
    group: 'Infra',
    load: () => import('../commands/db/restore'),
  },
  {
    path: ['db', 'seed'],
    description: "Run a D1 database's seed file",
    group: 'Infra',
    load: () => import('../commands/db/seed'),
  },
  {
    path: ['db', 'reset'],
    description: 'Recreate a local D1 database: migrate, then seed',
    group: 'Infra',
    load: () => import('../commands/db/reset'),
  },
  {
    path: ['logs'],
    description: "Tail a deployed worker's logs",
    group: 'Infra',
    load: () => import('../commands/logs'),
  },
  {
    path: ['open'],
    description: "Open a worker target's Cloudflare dashboard page",
    group: 'Develop',
    load: () => import('../commands/open'),
  },
  {
    path: ['release', 'rollback'],
    description: 'Roll a worker service back to an earlier version',
    group: 'Release',
    load: () => import('../commands/release/rollback'),
  },
  // end cloudflare workers
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
    path: ['add', 'module'],
    description: 'Add a KMP library module (Gradle or Kotlin toolchain)',
    group: 'Setup',
    load: () => import('../commands/add/module'),
  },
  {
    path: ['add', 'target'],
    description: 'Add a target to kit.config.ts',
    group: 'Setup',
    load: () => import('../commands/add/target'),
  },
  {
    path: ['add', 'maestro'],
    description: 'Scaffold the Maestro flows directory',
    group: 'Setup',
    load: () => import('../commands/add/maestro'),
  },
  {
    path: ['agents', 'guide'],
    description: 'Print the guide that tells coding agents how to drive this repo with kit',
    group: 'Setup',
    load: () => import('../commands/agents/guide'),
  },
  {
    path: ['agents', 'sync'],
    description: 'Write the guide into AGENTS.md; --hooks adds the Claude Code hook',
    group: 'Setup',
    load: () => import('../commands/agents/sync'),
  },
  {
    path: ['agents', 'hook'],
    description: 'The Claude Code PreToolUse hook: refuse a direct ./kotlin or ./gradlew build or test',
    group: 'Setup',
    load: () => import('../commands/agents/hook'),
  },
  {
    path: ['deps'],
    description: 'List or update npm dependencies (catalog-aware)',
    group: 'Setup',
    load: () => import('../commands/deps'),
  },
  {
    path: ['upgrade'],
    description: 'Move the repo to a kit release (npm pin, workflow SHAs); --global updates the kit on PATH',
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
  db: 'Cloudflare D1 migrations, queries, backup, restore, seed and reset',
  add: 'Scaffold a module, a target or the Maestro flows into this repo',
  agents: 'Point coding agents at kit: the AGENTS.md guide and the Claude Code hook',
  app: 'Build, install and launch the debug app on a device',
  device: 'Simulators, emulators and connected devices',
  fixture: 'Replay or capture app state on a device',
}
