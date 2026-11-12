export default {
  name: 'App',
  gradle: { root: 'client' },
  app: {
    ios: { bundleId: 'app.example', project: 'client/ios/iosApp.xcodeproj', scheme: 'iosApp' },
    android: { packageName: 'app.example', module: ':android' },
  },
}
