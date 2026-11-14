import { defineCommand } from '../../../cli/command'

export default defineCommand({
  description: 'Set up Android release secrets: create the upload keystore, store it and the Play key',
  group: 'Release',
  args: {
    alias: { type: 'string', description: 'Key alias (default key0)' },
    out: { type: 'string', description: 'Keystore file to create (default ~/.keystores/<name>.keystore)' },
    dn: { type: 'string', description: 'Certificate subject (default CN=<name>)' },
    'play-json': { type: 'string', description: 'Play service-account JSON key to store as base64' },
    github: {
      type: 'boolean',
      negatable: true,
      description: 'Set the GitHub Actions secrets with gh (asked when omitted)',
    },
    force: { type: 'boolean', description: 'Create a new upload key although .env already holds one' },
  },
  examples: [
    'kit release setup android',
    'kit release setup android --play-json ~/Downloads/play-key.json --github',
    'kit release setup android --alias upload --out keys/upload.jks --no-github',
    'kit release setup android --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { existsSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { requireProject } = await import('../../../cli/command')
    const { ExitCode, KitError } = await import('../../../lib/errors')
    const { emitJson } = await import('../../../lib/log')
    const { moduleKind } = await import('../../../lib/module')
    const ks = await import('../../../lib/release/keystore')
    const setup = await import('../../../lib/release/setup')
    const { root, config } = requireProject(ctx)
    if (!config.release?.android) {
      throw new KitError('No release.android in kit.config.ts', undefined, ExitCode.config)
    }

    const kind = moduleKind(config)
    const generator = ks.generatorFor(kind)
    const alias = ctx.args.alias?.trim() || ks.DEFAULT_ALIAS
    const file = ctx.args.out ? ks.resolveOut(root, ctx.args.out) : ks.defaultKeystorePath(config.name)
    const dn = ctx.args.dn?.trim() || ks.dnFor(config.name)

    // An upload key cannot be regenerated: an app that has one keeps it unless --force.
    const existing = ks.existingKeystoreSecrets(root)
    if (existing.length && existing.length < ks.KEYSTORE_SECRETS.length && !ctx.args.force) {
      const missing = ks.KEYSTORE_SECRETS.filter((k) => !existing.includes(k))
      throw new KitError(
        `.env holds ${existing.join(', ')} but not ${missing.join(', ')}`,
        'Fill in the missing values of the existing upload key, or pass --force to create a new one',
        ExitCode.usage,
      )
    }
    const create = !existing.length || !!ctx.args.force
    if (create && existsSync(file)) {
      throw new KitError(
        `${file} already exists`,
        'kit never overwrites a keystore; pass --out <path>, or move the file away',
        ExitCode.usage,
      )
    }
    const play = ctx.args['play-json'] ? setup.playServiceAccount(resolve(ctx.args['play-json'])) : undefined

    const notes = ks.buildConfigNotes(root, config, kind)
    const github = await setup.decideGithub(ctx.flags, ctx.args.github, 'the Android release secrets')

    const write = [...(create ? ks.KEYSTORE_SECRETS : []), ...(play ? ['PLAY_SERVICE_ACCOUNT_BASE64'] : [])]
    const plan = {
      keystore: create ? file : null,
      alias: create ? alias : null,
      generator: create ? generator : null,
      env: write,
      github: github ?? null,
    }
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ ...plan, notes, dryRun: true })
      else {
        if (create) ctx.log.step(`create ${file} (alias ${alias}) with ${generator}`)
        else ctx.log.step('keep the upload key .env already holds')
        if (write.length) ctx.log.step(`write ${write.join(', ')} to .env`)
        if (github) ctx.log.step('set the Android release secrets as GitHub Actions secrets')
        for (const n of notes) ctx.log.warn(n)
      }
      return
    }

    const values: Record<string, string> = {}
    let password: string | undefined
    if (create) {
      password = ks.generatePassword()
      await ks.generateKeystore(root, config, { generator, file, alias, password, dn })
      Object.assign(values, ks.keystoreSecretValues(file, alias, password))
    }
    if (play) values.PLAY_SERVICE_ACCOUNT_BASE64 = play
    setup.writeEnvSecrets(root, values)

    // GitHub gets every Android release secret .env now holds, not only what this run wrote.
    const stored = setup.dotenvValues(root)
    const names = [...ks.KEYSTORE_SECRETS, 'PLAY_SERVICE_ACCOUNT_BASE64'].filter((k) => k in stored)
    const push = github
      ? await setup.pushGithub(root, Object.fromEntries(names.map((k) => [k, stored[k]!])))
      : { pushed: [] }
    const playMissing = !('PLAY_SERVICE_ACCOUNT_BASE64' in stored)

    if (ctx.flags.json) {
      emitJson({ ...plan, ...(password ? { password } : {}), pushed: push.pushed, notes, ok: !push.error })
    } else {
      if (create) ctx.log.success(`created ${file}`)
      else ctx.log.info('upload key already in .env; kept (--force creates a new one)')
      if (write.length) ctx.log.success(`wrote ${write.join(', ')} to .env`)
      if (push.pushed.length) ctx.log.success(`set GitHub Actions secrets: ${push.pushed.join(', ')}`)
      if (password) {
        // The one time the password is printed. Written raw: nothing here redacts it.
        process.stderr.write(
          [
            '',
            'Upload key (kit prints the password only this once):',
            `  keystore  ${file}`,
            `  alias     ${alias}`,
            `  password  ${password}   (store and key)`,
            '',
            '.env now holds the whole key (keystore as base64, alias, password); GitHub secrets cannot be read back.',
            'Keep a copy outside this machine: losing both .env and the keystore file means an upload-key reset in Play Console.',
            '',
          ].join('\n'),
        )
        if (await ks.committable(root, file)) {
          ctx.log.warn(`${file} is inside the repo and not ignored; add it to .gitignore`)
        }
      }
      for (const n of notes) ctx.log.warn(n)
      if (playMissing) {
        ctx.log.dim('PLAY_SERVICE_ACCOUNT_BASE64 not set; add it with --play-json <service-account.json>')
      }
      if (!github) ctx.log.dim('GitHub Actions secrets not set (--github sets them)')
    }
    setup.assertPushed(push, names)
  },
})
