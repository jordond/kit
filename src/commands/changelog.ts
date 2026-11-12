import { defineCommand } from '../cli/command'

/**
 * `kit changelog`: the Conventional Commits since the last release tag, grouped into Breaking,
 * Features, Fixes, Performance and Other. Markdown on stdout, or `--write` puts a dated
 * `## <version>` section at the top of CHANGELOG.md (once per version; an Unreleased section is
 * rewritten in place). No external tool: it reads
 * `git log` and the release tags kit creates (`ios/v1.4.0+12`, `api/v0.3.0`).
 */
export default defineCommand({
  description: 'List the changes since the last release tag',
  group: 'Release',
  args: {
    from: { type: 'string', description: 'Start after this tag or ref (default: the last release tag)' },
    to: { type: 'string', description: 'End at this ref (default: HEAD)' },
    platform: { type: 'string', description: 'ios, android or a service: use its <name>/v* tags' },
    all: { type: 'boolean', description: 'Include chore, test, ci and style commits' },
    write: { type: 'boolean', description: 'Add the section to CHANGELOG.md, or to the file named after it' },
  },
  examples: [
    'kit changelog',
    'kit changelog --platform ios',
    'kit changelog --from v0.5.0 --to v0.6.0 --json',
    'kit changelog --write',
    'kit changelog --platform api --write docs/api-changes.md',
  ].join('\n'),
  async run(ctx) {
    const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
    const { dirname, isAbsolute, join } = await import('node:path')
    const { ANY_RELEASE_TAG, groupCommits, heading, prependSection, renderMarkdown, tagVersion, UNRELEASED } =
      await import('../lib/changelog')
    const { ExitCode, KitError } = await import('../lib/errors')
    const { describe, hasCommit, isShallow, logRange } = await import('../lib/git')
    const { emitJson } = await import('../lib/log')

    const root = ctx.root ?? process.cwd()
    const config = ctx.config
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const platform = str(ctx.args.platform)
    const write = ctx.args.write === true
    if (ctx.positionals.length > (write ? 1 : 0)) {
      throw new KitError(
        `Unexpected argument "${ctx.positionals[write ? 1 : 0]}"`,
        'A file name only follows --write',
        ExitCode.usage,
      )
    }
    if (platform && config) {
      const known = new Set(['ios', 'android', ...Object.keys(config.versions?.keys ?? {})])
      for (const name of Object.keys(config.targets ?? {})) known.add(name)
      if (!known.has(platform)) {
        throw new KitError(
          `Unknown platform "${platform}"`,
          `Known: ${[...known].join(', ')}`,
          ExitCode.usage,
        )
      }
    }

    const to = str(ctx.args.to) ?? 'HEAD'
    // A tag given as --to describes itself: look for the release before it. A first commit has
    // nothing before it; any other git failure (a bad ref, not a repository) stops the command.
    const tagFrom = str(ctx.args.to) ? `${to}~1` : to
    const match = platform ? `${platform}/v*` : ANY_RELEASE_TAG
    const from =
      str(ctx.args.from) ??
      (tagFrom === to || (await hasCommit(tagFrom, root))
        ? await describe(match, { cwd: root, ref: tagFrom })
        : undefined)
    // A shallow clone (CI's default checkout) has neither the tags nor the history: without a
    // tag, what `git log` returns is the fetched depth, not a release.
    const shallow = from === undefined && (await isShallow(root))
    const unshallow = 'Fetch the full history first: `git fetch --unshallow --tags`'
    if (shallow && write) {
      throw new KitError(
        `Shallow clone and no ${match} tag in it: the changes since the last release are unknown`,
        unshallow,
        ExitCode.precondition,
      )
    }
    const groups = groupCommits(await logRange(from, to, { cwd: root }), { all: ctx.args.all === true })
    const markdown = renderMarkdown(groups)
    const doc = { from: from ?? null, to, ...(shallow ? { shallow: true } : {}), sections: groups }
    const since = from ? `since ${from}` : 'in the history'

    if (!write) {
      if (shallow && !ctx.flags.json) {
        ctx.log.warn(`Shallow clone and no ${match} tag in it: this lists only the fetched commits`)
        ctx.log.dim(`  › ${unshallow}`)
      }
      if (ctx.flags.json) emitJson(doc)
      else if (markdown) process.stdout.write(markdown)
      else ctx.log.dim(`No changes ${since}`)
      return
    }

    // ---- --write -------------------------------------------------------------------------------
    const file = ctx.positionals[0] ?? 'CHANGELOG.md'
    const path = isAbsolute(file) ? file : join(root, file)
    let version = str(ctx.args.to) ? tagVersion(to) : undefined
    if (!version && platform && config?.versions?.keys[platform]) {
      const { readVersion } = await import('../lib/release/version')
      version = readVersion(root, config, platform)
    }
    if (!version && !platform && existsSync(join(root, 'package.json'))) {
      try {
        version = str(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
      } catch {}
    }
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    // No version to file the changes under: one Unreleased section, rewritten on every run.
    const head = heading(version ?? UNRELEASED, date, platform)
    const label = head.replace(/\s*\([^)]*\)$/, '')
    const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    const replaces = !version && !!before?.split('\n').some((l) => l === label || l.startsWith(`${label} `))
    const after = markdown ? prependSection(before, head, markdown, { replace: !version }) : undefined
    const written = after !== undefined && !ctx.flags.dryRun
    if (written) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, after)
    }
    if (ctx.flags.json) emitJson({ ...doc, file, heading: head, written })
    else if (!markdown) ctx.log.dim(`No changes ${since}: ${file} left as it is`)
    else if (after === undefined)
      ctx.log.dim(`- ${file}  ${replaces ? `${label} is up to date` : `already has ${label}`}`)
    else if (ctx.flags.dryRun)
      ctx.log.step(`would ${replaces ? 'update' : 'add'} ${head} ${replaces ? 'in' : 'to'} ${file}`)
    else ctx.log.success(`${file}: ${replaces ? 'updated' : 'added'} ${head}`)
  },
})
