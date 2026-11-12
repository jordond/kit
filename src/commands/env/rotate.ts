import { defineCommand } from '../../cli/command'
import type { PushPreflight } from '../../lib/env/push-run'

export default defineCommand({
  description: 'Generate a new value for keys the env schema marks `generate`, then sync',
  group: 'Infra',
  args: {
    push: { type: 'boolean', description: 'Push to the remotes that hold the key (as `kit env push`)' },
  },
  examples: [
    'kit env rotate INTERNAL_API_SECRET           # new value in .env, outputs re-rendered',
    'kit env rotate INTERNAL_API_SECRET --push    # and push it to its workers and GitHub',
    'kit env rotate KEY_A KEY_B --yes',
    'kit env rotate INTERNAL_API_SECRET --dry-run',
  ].join('\n'),
  async run(ctx) {
    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { requireProject } = await import('../../cli/command')
    const { loadEnv, assertValid } = await import('../../lib/env/load')
    const { outputs, writeAtomic, writeOutputs } = await import('../../lib/env/render')
    const { destinationsFor, generateValue, pushSelections, rewriteKey } = await import(
      '../../lib/env/rotate'
    )
    const { executePreflight, mergePreflights, preflightPush, pushCommand } = await import(
      '../../lib/env/push-run'
    )
    const { redact } = await import('../../lib/secrets')
    const { suggest } = await import('../../lib/targets')
    const { confirm } = await import('../../lib/prompt')
    const { emitJson } = await import('../../lib/log')
    const { ExitCode, KitError } = await import('../../lib/errors')
    const { root, config } = requireProject(ctx)

    const names = [...new Set(ctx.positionals)]
    if (!names.length) {
      throw new KitError(
        'kit env rotate takes one or more keys',
        'kit env rotate INTERNAL_API_SECRET',
        ExitCode.usage,
      )
    }
    const state = await loadEnv(root, config)
    const known = state.schema.keys
    const rotatable = known.filter((k) => k.generate).map((k) => k.name)
    const keys = names.map((name) => {
      const key = known.find((k) => k.name === name)
      if (!key) {
        const guess = suggest(
          name,
          known.map((k) => k.name),
        )
        throw new KitError(
          `Unknown env key "${name}"`,
          guess
            ? `Did you mean ${guess}?`
            : rotatable.length
              ? `Rotatable keys: ${rotatable.join(', ')}`
              : 'No key in the env schema declares `generate`',
          ExitCode.usage,
        )
      }
      if (!key.generate) {
        throw new KitError(
          `${name} is not rotatable: its schema declares no \`generate\``,
          'Rotate third-party keys at the provider, update .env, then run `kit env push`',
          ExitCode.usage,
        )
      }
      return { name, generate: key.generate }
    })

    // The rest of .env must already be valid: the render below needs it. The keys being replaced may be anything.
    assertValid({ ...state, issues: state.issues.filter((i) => !names.includes(i.key)) })

    // Mint and validate every value before anything is written.
    const fresh: Record<string, string> = {}
    for (const key of keys) {
      const value = generateValue(key.generate)
      const problem = state.schema.validateKey(key.name, value)
      if (problem) {
        throw new KitError(
          `Generated ${key.generate.kind} value for ${key.name} fails its schema: ${problem}`,
          'Fix `generate` / `length` or the rule in the env schema; nothing was written',
          ExitCode.config,
        )
      }
      fresh[key.name] = value
    }
    const next = await loadEnv(root, config, { ...process.env, ...fresh })
    assertValid(next)

    const rotated = keys.map((k) => ({ key: k.name, destinations: destinationsFor(config, k.name) }))
    const selections = pushSelections(config, names)
    const commands = selections.map(pushCommand)
    const dryRun = ctx.flags.dryRun
    const say = !ctx.flags.json

    // With --push and something to push; a dry run calls no remote.
    const pushing = !!ctx.args.push && !dryRun && commands.length > 0
    const pending = commands.join(' && ')
    const doc = { dryRun, rotated, outputs: [] as string[], push: commands }
    const message = (err: unknown) => redact(err instanceof Error ? err.message : String(err))

    if (say) {
      for (const r of rotated) {
        const where = r.destinations.length ? r.destinations.join(', ') : 'no remote, local only'
        ctx.log.info(`${r.key}  → ${where}`)
      }
    }

    // Everything that can refuse the push (account pin, wrangler / gh auth) runs before .env changes,
    // with --yes too: a listing that fails means the puts would fail on the same login.
    let preflight: PushPreflight | undefined
    if (pushing) {
      const parts: PushPreflight[] = []
      for (const selection of selections) {
        parts.push(await preflightPush(ctx, root, config, next.values, selection, { strict: true }))
      }
      preflight = mergePreflights(parts)
      if (preflight.listFailed.length) {
        throw new KitError(
          `could not list secrets on ${preflight.listFailed.join(', ')}; nothing was rotated`,
          'Fix the wrangler / gh login and re-run; `kit env rotate` never writes before it can list its remotes',
          ExitCode.failed,
        )
      }
    }

    if (!dryRun) {
      // One confirm for the whole run: nothing is asked once .env has changed.
      const question = preflight
        ? `Rotate ${names.join(', ')} and push ${preflight.count} secret(s) to ${preflight.plans.map((p) => p.destination.name).join(', ')}? The current value stops working.`
        : `Rotate ${names.join(', ')}? The current value stops working once the new one is pushed.`
      if (!(await confirm(ctx.flags, question))) {
        throw new KitError('Cancelled', undefined, ExitCode.interrupted)
      }
      const file = join(root, '.env')
      let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      for (const key of keys) text = rewriteKey(text, key.name, fresh[key.name]!)
      writeAtomic(file, text)
      // Later steps in this run (the push) read the process env.
      for (const key of keys) process.env[key.name] = fresh[key.name]
    }

    // The same render `kit env sync` does, so local outputs match the new value.
    try {
      doc.outputs = writeOutputs(root, outputs(config, next.schema), next.values, dryRun)
        .filter((r) => r.changed)
        .map((r) => r.path)
    } catch (err) {
      if (dryRun) throw err
      // .env is already rewritten: say so, and how to finish, instead of a bare render error.
      const finish = pending ? `kit env sync && ${pending}` : 'kit env sync'
      const error = `.env holds the new ${names.join(', ')}, but rendering outputs failed (${message(err)}); outputs may be stale and nothing was pushed`
      ctx.log.error(error, `Fix the cause, then run: ${finish}`)
      if (ctx.flags.json) emitJson({ ...doc, pushed: false, pending: finish, error })
      process.exitCode = ExitCode.failed
      return
    }
    if (say) {
      ctx.log.success(`${dryRun ? 'would rotate' : 'rotated'} ${names.join(', ')} in .env`)
      for (const path of doc.outputs) ctx.log.success(`${dryRun ? 'would write' : 'wrote'} ${path}`)
      if (!commands.length) ctx.log.dim('  no worker or GitHub secret holds these keys; nothing to push')
    }

    if (!preflight) {
      if (dryRun) {
        if (say) for (const c of commands) ctx.log.step(`would push with: ${c}`)
        if (ctx.flags.json) emitJson({ ...doc, pushed: false })
        return
      }
      // Rotated but not pushed: said on stderr under --json too, and carried in the document.
      if (pending) ctx.log.warn(`not pushed yet; push the new value with: ${pending}`)
      if (ctx.flags.json) emitJson({ ...doc, pushed: false, ...(pending ? { pending } : {}) })
      return
    }

    let outcomes: { destination: string; key: string; status: string }[] = []
    let ok = false
    let error: string | undefined
    try {
      const report = await executePreflight(ctx, preflight, next.values)
      // Names and statuses only: child output stays out of the document.
      outcomes = report.outcomes.map(({ destination, key, status }) => ({ destination, key, status }))
      ok = report.ok
    } catch (err) {
      error = message(err)
      ctx.log.error(error)
    }
    if (ok) {
      if (ctx.flags.json) emitJson({ ...doc, pushed: true, outcomes })
      return
    }
    ctx.log.warn(`.env holds the new value but the push did not finish; after fixing it run: ${pending}`)
    if (ctx.flags.json) emitJson({ ...doc, pushed: false, pending, outcomes, ...(error ? { error } : {}) })
    process.exitCode = ExitCode.failed
  },
})
