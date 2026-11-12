export default {
  name: 'Shots App',
  app: {
    ios: { bundleId: 'app.example', project: 'ios/iosApp.xcodeproj', scheme: 'iosApp' },
    android: { packageName: 'app.example', module: ':android' },
  },
  maestro: { dir: 'maestro', version: '2.9.0' },
  shots: {
    project: 'brand/studio.json',
    fonts: [{ family: 'Kit Fixture', file: 'brand/fonts/fixture.ttf', weight: '400 800' }],
    brand: { mark: 'brand/mark.svg', wordmark: 'shots', color: '#2c1e14', font: 'Kit Fixture' },
  },
  release: {
    ios: {
      bundleIds: ['app.example'],
      project: 'ios/iosApp.xcodeproj',
      scheme: 'iosApp',
      output: 'App.ipa',
      metadata: 'fastlane/metadata',
    },
    android: { packageName: 'app.example', module: ':android', metadata: 'fastlane/metadata/android' },
  },
}
