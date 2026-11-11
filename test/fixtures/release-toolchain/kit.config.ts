export default {
  name: 'App',
  toolchain: { root: '.' },
  versions: {
    file: 'libs.versions.toml',
    keys: { android: 'app-android-version' },
  },
  targets: { app: { kind: 'kotlin', dir: '.' } },
  release: {
    android: {
      packageName: 'app.example',
      module: 'androidApp',
      gates: [{ task: 'test -m shared', tracks: ['beta', 'prod'] }],
    },
  },
}
