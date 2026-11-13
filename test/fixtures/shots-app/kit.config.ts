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
    pages: [
      { name: 'header', file: 'brand/pages/header.html', width: 1920, height: 800, background: '#faf2e4' },
      { name: 'search', file: 'brand/pages/header.html', width: 1200, height: 800, scale: 1, out: 'build/art/search.png' },
    ],
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
