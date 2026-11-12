import { relative, resolve } from 'node:path'
import { type KitContext, requireProject } from '../cli/command'
import { wrangler } from '../lib/cloudflare'
import { ExitCode, KitError } from '../lib/errors'
import { currentBranch } from '../lib/git'

import { emitJson } from '../lib/log'
import { runLines, runPiped, runToStderr } from '../lib/proc'
import { targetCommands } from '../lib/targets'
import {
  parsePr,
  parseVersionUpload,
  previewAlias,
  previewComment,
  readWranglerConfig,
  requireWorker,
  versionsUploadArgs,
  workerName,
} from '../lib/worker'
import { beforeCommands, checkEnv } from './deploy'

type CommentOutcome = 'created' | 'updated' | 'no-pr' | 'no-url' | 'failed'

type Ctx = Pick<KitContext, 'root' | 'config' | 'flags' | 'log' | 'rest'>

/**
 * Post the preview URL on the branch's PR, or update kit's earlier comment for the same target
 * (its own comment opening with the marker, so nobody else's is ever edited). No PR is a warning,
 * not a failure; anything else that goes wrong with gh is.
 */
async function commentOnPr(
  ctx: Ctx,
  root: string,
  branch: string | undefined,
  target: string,
  body: string,
): Promise<CommentOutcome> {
  const view = await runPiped(
    ['gh', 'pr', 'view', ...(branch ? [branch] : []), '--json', 'number,comments'],
    {
      cwd: root,
    },
  )
  // Only gh saying there is no PR is "no PR"; a missing login or a network error is a failure.
  if (view.code !== 0 && /no pull requests found/i.test(view.stderr)) {
    ctx.log.warn(`no pull request for ${branch ?? 'this branch'}; not commenting`)
    return 'no-pr'
  }
  const pr = view.code === 0 ? parsePr(view.stdout, target) : undefined
  if (!pr) {
    ctx.log.error(
      `could not look up the pull request (gh pr view exited with ${view.code})`,
      view.stderr.trim().split('\n')[0] || undefined,
    )
    return 'failed'
  }
  const cmd = pr.commentId
    ? [
        'gh',
        'api',
        '--method',
        'PATCH',
        `repos/{owner}/{repo}/issues/comments/${pr.commentId}`,
        '-f',
        `body=${body}`,
      ]
    : ['gh', 'pr', 'comment', String(pr.number), '--body', body]
  const done = await runPiped(cmd, { cwd: root })
  if (done.code !== 0) {
    ctx.log.error(`commenting on #${pr.number} failed (exit ${done.code})`, done.stderr.trim() || undefined)
    return 'failed'
  }
  ctx.log.success(`${pr.commentId ? 'updated the comment on' : 'commented on'} #${pr.number}`)
  return pr.commentId ? 'updated' : 'created'
}

/**
 * `kit deploy <target> --preview`: `deploy.before`, then `wrangler versions upload` (production
 * traffic stays where it is) with a preview alias from the branch. The preview URL is the result:
 * everything else, wrangler's output included, goes to stderr.
 */
export async function runPreview(
  ctx: Ctx,
  names: string[],
  opts: { env?: string; comment: boolean },
): Promise<void> {
  const { root, config } = requireProject(ctx)
  if (names.length !== 1) {
    throw new KitError('kit deploy --preview takes one worker target', undefined, ExitCode.usage)
  }
  const name = names[0]!
  const target = requireWorker(config, name, 'kit deploy --preview')
  const env = checkEnv(config, name, opts.env)
  const worker = workerName(readWranglerConfig(resolve(root, target.dir))?.data ?? {}, env) ?? name
  // On a pull_request run HEAD is detached; Actions names the branch.
  const branch = process.env.GITHUB_HEAD_REF || (await currentBranch(root).catch(() => undefined))
  const alias = previewAlias(branch, worker)
  const w = wrangler(root, config, name, ...versionsUploadArgs({ env, alias, extra: ctx.rest }))
  // A custom deploy usually builds before it uploads (`['bun run build', 'wrangler deploy']`); a
  // preview of stale output would be a lie, so it needs the target's own build command to run first.
  const d = target.deploy
  // `{ before }` without `run` is still the default deploy.
  const custom = d === undefined || d === false || typeof d === 'string' || Array.isArray(d) ? d : d.run
  if (d === false || custom === false) {
    throw new KitError(
      `Target "${name}" is not deployable (deploy: false), so it has no preview`,
      undefined,
      ExitCode.usage,
    )
  }
  const hasBuild = target.build !== undefined && target.build !== false
  if (custom !== undefined && !hasBuild) {
    throw new KitError(
      `A preview of "${name}" needs targets.${name}.build`,
      `targets.${name}.deploy is a custom command; kit runs the target's build, then wrangler versions upload`,
      ExitCode.usage,
    )
  }
  const build = custom !== undefined ? (targetCommands(root, config, name, 'build', { env }) ?? []) : []
  const self = [process.execPath, '--no-env-file', process.argv[1]!]
  const before = beforeCommands(config, name).map((args) => ({
    title: `kit ${args.join(' ')}`,
    cmd: [...self, ...args, ...(ctx.flags.yes ? ['--yes'] : [])],
  }))

  if (ctx.flags.dryRun) {
    const plan = [
      ...before.map((b) => b.title),
      ...build.map((c) => c.cmd.join(' ')),
      w.cmd.join(' '),
      ...(opts.comment ? ['gh pr comment (when the branch has a pull request)'] : []),
    ]
    if (ctx.flags.json) emitJson({ dryRun: true, target: name, env, alias, plan })
    else for (const step of plan) ctx.log.step(`${name}  ${step}`)
    return
  }

  for (const b of before) {
    ctx.log.step(b.title)
    const code = await runToStderr(b.cmd, { cwd: root, env: { KIT_ROOT: root } })
    if (code !== 0) {
      throw new KitError(
        `${b.title} failed (exit ${code}); not uploading ${name}`,
        undefined,
        ExitCode.precondition,
      )
    }
  }
  for (const c of build) {
    ctx.log.step(`${name}: ${c.title}`)
    const code = await runToStderr(c.cmd, { cwd: c.cwd, env: c.env })
    if (code !== 0) {
      throw new KitError(`build ${name} failed (exit ${code}); not uploading`, undefined, ExitCode.failed)
    }
  }
  if (!alias) ctx.log.warn(`no preview alias from ${branch ?? 'this checkout'}; using the version URL`)
  ctx.log.step(`${name}: ${relative(root, w.cwd) || '.'} $ ${w.cmd.join(' ')}`)
  const { code, output } = await runLines(w.cmd, {
    cwd: w.cwd,
    env: env ? { KIT_ENV: env } : undefined,
    onLine: (line) => process.stderr.write(`${line}\n`),
  })
  if (code !== 0) {
    if (ctx.flags.json) emitJson({ ok: false, target: name, env, error: `wrangler exited with ${code}` })
    else ctx.log.error(`preview ${name} failed (exit ${code})`)
    process.exitCode = ExitCode.failed
    return
  }
  const { url, version } = parseVersionUpload(output)
  if (!url) {
    ctx.log.warn(
      `uploaded ${name}${version ? ` (${version})` : ''}, but wrangler printed no preview URL; enable Preview URLs for the worker`,
    )
  }
  // The URL first: nothing gh does afterwards may keep the result off stdout.
  if (!ctx.flags.json && url) process.stdout.write(`${url}\n`)
  let comment: CommentOutcome | undefined
  if (opts.comment) {
    comment = !url
      ? 'no-url'
      : await commentOnPr(ctx, root, branch, name, previewComment({ target: name, url, version, env })).catch(
          (e: unknown) => {
            // gh not installed: the spawn itself throws.
            ctx.log.error(`could not run gh: ${e instanceof Error ? e.message : String(e)}`)
            return 'failed' as const
          },
        )
    if (comment === 'failed') process.exitCode = ExitCode.failed
  }
  if (ctx.flags.json) {
    emitJson({
      ok: comment !== 'failed',
      target: name,
      env,
      url: url ?? null,
      version: version ?? null,
      alias,
      ...(comment ? { comment } : {}),
    })
  }
}
