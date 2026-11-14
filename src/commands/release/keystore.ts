import { defineCommand } from '../../cli/command'

export default defineCommand({
  description: 'Create the Android upload keystore and store it in .env and GitHub Actions secrets',
  group: 'Release',
  args: {
    alias: { type: 'string', description: 'Key alias (default key0)' },
    out: { type: 'string', description: 'Keystore file to create (default ~/.keystores/<name>.keystore)' },
    dn: { type: 'string', description: 'Certificate subject (default CN=<name>)' },
    github: {
      type: 'boolean',
      negatable: true,
      description: 'Set the GitHub Actions secrets with gh (asked when omitted)',
    },
    force: { type: 'boolean', description: 'Replace ANDROID_KEYSTORE_* values already in .env' },
  },
  examples: [
    'kit release keystore',
    'kit release keystore --alias upload --github',
    'kit release keystore --out keys/upload.jks --no-github',
    'kit release keystore --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { existsSync } = await import('node:fs')
    const { requireProject } = await import('../../cli/command')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { emitJson } = await import('../../lib/log')
    const { moduleKind } = await import('../../lib/module')
    const { confirm } = await import('../../lib/prompt')
    const { githubDestination } = await import('../../lib/env/push')
    const ks = await import('../../lib/release/keystore')
    const { root, config } = requireProject(ctx)
    if (!config.release?.android) {
      throw new KitError('No release.android in kit.config.ts', undefined, ExitCode.config)
    }

    const kind = moduleKind(config)
    const generator = ks.generatorFor(kind)
    const alias = ctx.args.alias?.trim() || ks.DEFAULT_ALIAS
    const file = ctx.args.out ? ks.resolveOut(root, ctx.args.out) : ks.defaultKeystorePath(config.name)
    const dn = ctx.args.dn?.trim() || ks.dnFor(config.name)

    // An upload key cannot be regenerated: never write over a keystore, or over stored secrets unasked.
    if (existsSync(file)) {
      throw new KitError(
        `${file} already exists`,
        'kit never overwrites a keystore; pass --out <path>, or move the file away',
        ExitCode.usage,
      )
    }
    const existing = ks.existingKeystoreSecrets(root)
    if (existing.length && !ctx.args.force) {
      throw new KitError(
        `.env already holds ${existing.join(', ')}`,
        'This app has an upload key. Pass --force to replace it (Play then needs an upload-key reset)',
        ExitCode.usage,
      )
    }

    const notes = ks.buildConfigNotes(root, config, kind)
    let github = ctx.args.github
    if (github === undefined && !ctx.flags.dryRun) {
      github =
        ctx.flags.interactive || ctx.flags.yes
          ? await confirm(ctx.flags, `Set ${ks.KEYSTORE_SECRETS.join(', ')} as GitHub Actions secrets?`, {
              initial: true,
            })
          : false
    }
    if (github && !Bun.which('gh')) {
      throw new KitError('gh not found', 'Install the GitHub CLI, or pass --no-github', ExitCode.config)
    }

    const plan = { keystore: file, alias, generator, env: [...ks.KEYSTORE_SECRETS], github: github ?? null }
    if (ctx.flags.dryRun) {
      if (ctx.flags.json) emitJson({ ...plan, notes, dryRun: true })
      else {
        ctx.log.step(`create ${file} (alias ${alias}) with ${generator}`)
        ctx.log.step(`write ${ks.KEYSTORE_SECRETS.join(', ')} to .env`)
        if (github) ctx.log.step('set the same names as GitHub Actions secrets')
        for (const n of notes) ctx.log.warn(n)
      }
      return
    }

    const password = ks.generatePassword()
    await ks.generateKeystore(root, config, { generator, file, alias, password, dn })
    const values = ks.keystoreSecretValues(file, alias, password)
    ks.writeKeystoreSecrets(root, values)

    const pushed: string[] = []
    let pushError: string | undefined
    if (github) {
      const dest = githubDestination(root, [...ks.KEYSTORE_SECRETS])
      for (const key of dest.keys) {
        const r = await dest.put(key, values[key]!)
        if (r.code !== 0) {
          pushError = r.output.trim().split('\n')[0] || `gh secret set ${key} failed (exit ${r.code})`
          break
        }
        pushed.push(key)
      }
    }

    // The one time the password is shown. Written raw: the logger's callers redact registered values.
    if (ctx.flags.json) {
      emitJson({ ...plan, password, pushed, notes, ok: !pushError })
    } else {
      ctx.log.success(`created ${file}`)
      ctx.log.success(`wrote ${ks.KEYSTORE_SECRETS.join(', ')} to .env`)
      if (pushed.length) ctx.log.success(`set GitHub Actions secrets: ${pushed.join(', ')}`)
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
      for (const n of notes) ctx.log.warn(n)
      if (!github)
        ctx.log.dim('GitHub Actions secrets not set (--github sets them; or `gh secret set <NAME>`)')
    }
    if (pushError) {
      throw new KitError(
        `GitHub Actions secrets not fully set: ${pushError}`,
        `The keystore and .env are written. Set the rest by hand: ${ks.KEYSTORE_SECRETS.filter((k) => !pushed.includes(k)).join(', ')}`,
      )
    }
  },
})
