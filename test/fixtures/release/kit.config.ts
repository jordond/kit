export default {
  name: 'App',
  gradle: { root: 'client' },
  versions: {
    file: 'client/gradle/libs.versions.toml',
    keys: { ios: 'app-ios-version', android: 'app-android-version', api: 'api-version' },
  },
  release: {
    preflight: ['.kit/preflight/check.ts'],
    ios: {
      bundleIds: ['app.example', 'app.example.widget'],
      project: 'client/ios/iosApp.xcodeproj',
      scheme: 'iosApp',
      output: 'App.ipa',
      teamId: 'TEAM123',
      xcconfig: 'client/ios/Configuration/Config.xcconfig',
      testflightGroups: { beta: 'Beta Testers' },
      sentry: { org: 'org', project: 'ios' },
    },
    android: {
      packageName: 'app.example',
      module: ':android',
      gates: [{ task: ':android:verifyBaselineProfile', tracks: ['beta', 'prod'] }],
    },
    services: { api: { versionKey: 'api', build: 'echo building', deploy: 'echo deploying' } },
  },
}
