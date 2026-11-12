export default {
  name: 'App',
  toolchain: { root: '.' },
  app: {
    ios: { bundleId: 'app.example', project: 'iosApp/iosApp.xcodeproj', scheme: 'iosApp' },
    android: { packageName: 'app.example', module: 'androidApp' },
  },
}
