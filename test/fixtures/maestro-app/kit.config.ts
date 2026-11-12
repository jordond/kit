export default {
  name: 'Maestro App',
  gradle: { root: '.' },
  app: {
    ios: { bundleId: 'app.example', project: 'ios/iosApp.xcodeproj', scheme: 'iosApp' },
    android: { packageName: 'app.example', module: ':android' },
  },
  maestro: {
    dir: 'maestro',
    version: '2.9.0',
    suites: {
      qa: { stages: [['smoke'], ['onboarding']], env: { LOCALE: 'en' } },
      'shots-full': { extends: 'shots', stages: [['screenshots'], ['screenshots-extra']] },
    },
  },
}
