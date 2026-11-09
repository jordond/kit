export default {
  name: 'Setup',
  gradle: { root: 'apps/client' },
  targets: {
    api: { kind: 'worker', dir: 'apps/api' },
    client: { kind: 'gradle', dir: 'apps/client' },
  },
  release: { android: { packageName: 'app.setup', module: ':android' } },
}
