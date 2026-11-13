// A Kotlin toolchain project whose modules are not direct children of toolchain.root.
import { defineConfig } from '@jordond/kit'

export default defineConfig({
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
      module: 'mobile/android',
      gates: [{ task: 'test -m core', tracks: ['beta', 'prod'] }],
    },
  },
})
