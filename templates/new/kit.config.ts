import { defineConfig } from '@jordond/kit'

// kit config: values only (strings, numbers, booleans, lists, paths). Need logic? Add
// .kit/commands/<verb>.ts. Paths are relative to this file.
export default defineConfig({
  name: '{{name}}',
  gradle: { root: 'apps/client' },
  versions: {
    file: 'apps/client/gradle/libs.versions.toml',
    keys: { ios: 'app-ios-version', android: 'app-android-version' },
  },
  targets: {
    client: { kind: 'gradle', dir: 'apps/client' },
  },
})
