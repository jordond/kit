export default {
  name: 'Infra',
  env: {
    schema: '.kit/env.ts',
    outputs: {
      'apps/edge/.dev.vars': { pick: ['API_SECRET', 'PUBLIC_URL', 'OPTIONAL_KEY'] },
      'apps/admin/.dev.vars': { rename: { X_INTERNAL_SECRET: 'API_SECRET' } },
    },
    workerSecrets: { edge: ['API_SECRET', 'OPTIONAL_KEY'], admin: ['API_SECRET'] },
    githubSecrets: ['DEPLOY_TOKEN'],
  },
  targets: {
    edge: { kind: 'worker', dir: 'apps/edge' },
    admin: { kind: 'worker', dir: 'apps/admin' },
    analytics: { kind: 'worker', dir: 'apps/analytics' },
  },
  cloudflare: {
    accountId: 'from-wrangler',
    d1: {
      db: { name: 'infra-db', target: 'edge' },
      analytics: { name: 'infra-analytics', target: 'analytics' },
    },
  },
}
