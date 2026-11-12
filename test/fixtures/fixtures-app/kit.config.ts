export default {
  name: 'Fixtures',
  gradle: { root: '.' },
  app: {
    ios: { bundleId: 'app.example', project: 'ios/iosApp.xcodeproj', scheme: 'iosApp' },
    android: { packageName: 'app.example', module: ':android' },
  },
  fixtures: {
    dir: 'fx',
    files: [
      { from: 'app.db', ios: 'Documents/databases', android: 'databases', sqlite: true },
      { from: 'settings.json', ios: 'Documents', android: 'files' },
      { from: 'photos/', ios: 'Documents/photos', android: 'files/photos' },
    ],
    clear: { ios: ['Library/Caches'], android: ['cache'] },
    prepare: 'prepare',
  },
}
