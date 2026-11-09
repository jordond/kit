export default {
  name: 'Fixture',
  gradle: { root: 'apps/client' },
  workspace: { prepare: 'prep', lint: 'biome check .', typecheck: 'tsc --noEmit' },
  targets: {
    api: { kind: 'worker', dir: 'apps/api', build: 'bun run build' },
    web: { kind: 'astro', dir: 'apps/web', envs: ['staging'] },
    client: { kind: 'gradle', dir: 'apps/client', test: [':shared:test', ':android:test'] },
  },
  release: { android: { packageName: 'app.fixture', module: ':android' } },
}
