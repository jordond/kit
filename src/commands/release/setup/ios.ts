import { defineCommand } from '../../../cli/command'

const REQUIRED = [
  'ASC_KEY_ID',
  'ASC_ISSUER_ID',
  'ASC_KEY_P8_BASE64',
  'MATCH_GIT_URL',
  'MATCH_PASSWORD',
] as const
const BASIC = 'MATCH_GIT_BASIC_AUTHORIZATION'

export default defineCommand({
  description: 'Set up iOS release secrets: the App Store Connect API key and match access',
  group: 'Release',
  args: {
    p8: { type: 'string', description: 'App Store Connect API key file (AuthKey_<id>.p8)' },
    'key-id': { type: 'string', description: 'API key id (default: from the .p8 file name)' },
    'issuer-id': { type: 'string', description: 'App Store Connect issuer id' },
    'match-url': { type: 'string', description: 'Git URL of the match repo' },
    github: {
      type: 'boolean',
      negatable: true,
      description: 'Set the GitHub Actions secrets with gh (asked when omitted)',
    },
    verify: {
      type: 'boolean',
      negatable: true,
      description: 'Check the key with App Store Connect and the match repo with git (default on)',
    },
    force: { type: 'boolean', description: 'Ask again for values .env already holds' },
  },
  examples: [
    'kit release setup ios',
    'kit release setup ios --p8 ~/Downloads/AuthKey_ABC123DEFG.p8 --issuer-id <uuid> --match-url git@github.com:me/certs.git',
    'kit release setup ios --github          # also: push what .env already holds',
    'kit release setup ios --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { resolve } = await import('node:path')
    const { requireProject } = await import('../../../cli/command')
    const { ExitCode, KitError } = await import('../../../lib/errors')
    const { emitJson } = await import('../../../lib/log')
    const prompt = await import('../../../lib/prompt')
    const { registerSecret } = await import('../../../lib/secrets')
    const { generatePassword } = await import('../../../lib/release/keystore')
    const setup = await import('../../../lib/release/setup')
    const { root, config } = requireProject(ctx)
    if (!config.release?.ios) {
      throw new KitError('No release.ios in kit.config.ts', undefined, ExitCode.config)
    }

    const stored = setup.dotenvValues(root)
    const ask = ctx.flags.interactive
    // A value kit already has: .env, else the environment. --force in a terminal asks again.
    const known = (name: string): string | undefined =>
      ctx.args.force && ask ? undefined : stored[name] || process.env[name]?.trim() || undefined
    const next: Record<string, string> = {}

    // ---- App Store Connect API key
    const p8File = ctx.args.p8 ? resolve(ctx.args.p8) : undefined
    let p8 = p8File ? setup.ascKeyFile(p8File) : known('ASC_KEY_P8_BASE64')
    let p8Asked: string | undefined
    if (!p8 && ask) {
      p8Asked = resolve(
        (
          await prompt.text(ctx.flags, 'Path to the App Store Connect API key (AuthKey_<id>.p8)', {
            validate: (v) => (v.trim() ? undefined : 'Required'),
          })
        )
          .trim()
          .replace(/^~(?=\/)/, process.env.HOME ?? '~'),
      )
      p8 = setup.ascKeyFile(p8Asked)
    }
    if (p8) next.ASC_KEY_P8_BASE64 = p8

    const fromName = setup.keyIdFromFile(p8File ?? p8Asked ?? '')
    let keyId = ctx.args['key-id']?.trim() || fromName || known('ASC_KEY_ID')
    if (!keyId && ask) {
      keyId = (
        await prompt.text(ctx.flags, 'API key id', {
          validate: (v) => (setup.KEY_ID_RE.test(v.trim()) ? undefined : 'Like ABC123DEFG'),
        })
      ).trim()
    }
    if (keyId && !setup.KEY_ID_RE.test(keyId)) {
      throw new KitError(`"${keyId}" is not an API key id`, 'It looks like ABC123DEFG', ExitCode.usage)
    }
    if (keyId) next.ASC_KEY_ID = keyId

    let issuer = ctx.args['issuer-id']?.trim() || known('ASC_ISSUER_ID')
    if (!issuer && ask) {
      issuer = (
        await prompt.text(ctx.flags, 'Issuer id (App Store Connect → Users and Access → Integrations)', {
          validate: (v) => (setup.ISSUER_RE.test(v.trim()) ? undefined : 'A UUID'),
        })
      ).trim()
    }
    if (issuer && !setup.ISSUER_RE.test(issuer)) {
      throw new KitError(`"${issuer}" is not an issuer id`, 'It is a UUID', ExitCode.usage)
    }
    if (issuer) next.ASC_ISSUER_ID = issuer

    // ---- match
    let matchUrl = ctx.args['match-url']?.trim() || known('MATCH_GIT_URL')
    if (!matchUrl && ask) {
      matchUrl = (
        await prompt.text(ctx.flags, 'Git URL of the match repo', {
          placeholder: 'git@github.com:you/apple-signing.git',
          validate: (v) => (v.trim() ? undefined : 'Required'),
        })
      ).trim()
    }
    if (matchUrl) next.MATCH_GIT_URL = matchUrl

    let matchPassword = known('MATCH_PASSWORD')
    let generated = false
    if (!matchPassword && ask) {
      matchPassword = await prompt.password(
        ctx.flags,
        'match password (leave empty to generate one for a new match repo)',
      )
      if (!matchPassword) {
        matchPassword = generatePassword()
        generated = true
      }
    }
    if (matchPassword) next.MATCH_PASSWORD = matchPassword

    let basic = known(BASIC)
    if (!basic && ask) {
      const user = (
        await prompt.text(
          ctx.flags,
          'GitHub user for CI access to the match repo over HTTPS (leave empty to skip)',
        )
      ).trim()
      if (user) {
        const token = await prompt.password(
          ctx.flags,
          `Access token of ${user} with read access to the repo`,
          {
            validate: (v) => (v.trim() ? undefined : 'Required'),
          },
        )
        basic = setup.basicAuthorization(user, token.trim())
      }
    }
    if (basic) next[BASIC] = basic

    const missing = REQUIRED.filter((k) => !next[k])
    if (missing.length) {
      throw new KitError(
        `Missing ${missing.join(', ')}`,
        'Pass --p8, --issuer-id and --match-url; set MATCH_PASSWORD in .env or the environment; or run this in a terminal to be asked',
        ExitCode.usage,
      )
    }
    for (const k of ['ASC_KEY_P8_BASE64', 'MATCH_PASSWORD', BASIC]) registerSecret(next[k])

    // ---- checks, before anything is stored
    const verified = { asc: 'skipped', match: 'skipped' } as { asc: string; match: string }
    let matchError: string | undefined
    if (ctx.args.verify !== false) {
      verified.asc = await setup.verifyAscKey(next.ASC_KEY_ID!, next.ASC_ISSUER_ID!, next.ASC_KEY_P8_BASE64!)
      const repo = await setup.verifyMatchRepo(root, next.MATCH_GIT_URL!)
      verified.match = repo.ok ? 'ok' : 'unreachable'
      matchError = repo.error
    }

    const github = await setup.decideGithub(ctx.flags, ctx.args.github, 'the iOS release secrets')
    const names = [...REQUIRED, ...(next[BASIC] ? [BASIC] : [])]
    const write = names.filter((k) => stored[k] !== next[k])
    const plan = { env: write, github: github ?? null, verified }
    const warnings = (): void => {
      if (verified.asc === 'unreachable')
        ctx.log.warn('could not reach App Store Connect; the API key is unchecked')
      if (verified.match === 'unreachable') {
        ctx.log.warn(`this machine cannot read the match repo${matchError ? `: ${matchError}` : ''}`)
      }
      if (!next[BASIC]) {
        ctx.log.dim(`${BASIC} not set; GitHub Actions needs it to clone the match repo over HTTPS`)
      }
    }
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ ...plan, dryRun: true })
      else {
        ctx.log.step(write.length ? `write ${write.join(', ')} to .env` : '.env already holds every value')
        if (github) ctx.log.step('set the iOS release secrets as GitHub Actions secrets')
        warnings()
      }
      return
    }

    setup.writeEnvSecrets(root, Object.fromEntries(write.map((k) => [k, next[k]!])))
    const push = github
      ? await setup.pushGithub(root, Object.fromEntries(names.map((k) => [k, next[k]!])))
      : { pushed: [] }

    if (ctx.flags.json) {
      emitJson({
        ...plan,
        ...(generated ? { matchPassword: next.MATCH_PASSWORD } : {}),
        pushed: push.pushed,
        ok: !push.error,
      })
    } else {
      if (verified.asc === 'ok') ctx.log.success('App Store Connect accepted the API key')
      if (verified.match === 'ok') ctx.log.success('match repo is readable')
      if (write.length) ctx.log.success(`wrote ${write.join(', ')} to .env`)
      else ctx.log.info('.env already holds every value; nothing written')
      if (push.pushed.length) ctx.log.success(`set GitHub Actions secrets: ${push.pushed.join(', ')}`)
      if (generated) {
        process.stderr.write(
          [
            '',
            'match password (kit prints it only this once; it is also in .env):',
            `  ${next.MATCH_PASSWORD}`,
            'It encrypts the match repo. Every machine and CI job that signs needs the same one.',
            '',
          ].join('\n'),
        )
      }
      warnings()
      if (!github) ctx.log.dim('GitHub Actions secrets not set (--github sets them)')
      ctx.log.dim('next: `kit release certs --add` creates the certificates and profiles this app is missing')
    }
    setup.assertPushed(push, names)
  },
})
