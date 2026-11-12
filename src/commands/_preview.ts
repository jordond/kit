import { relative, resolve } from 'node:path'
import { type KitContext, requireProject } from '../cli/command'
import { wrangler } from '../lib/cloudflare'
import { ExitCode, KitError } from '../lib/errors'
import { currentBranch } from '../lib/git'
import { emitJson } from '../lib/log'
import { runLines, runPiped, runToStderr } from '../lib/proc'
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
 * (found by its marker, so nobody else's comment is ever edited). No PR is a warning, not a failure.
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
  const pr = view.code === 0 ? parsePr(view.stdout, target) : undefined
  if (!pr) {
    const why = view.stderr.trim().split('\n')[0]
    ctx.log.warn(`no pull request for ${branch ?? 'this branch'}; not commenting${why ? ` (${why})` : ''}`)
    return 'no-pr'
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
  const self = [process.execPath, '--no-env-file', process.argv[1]!]
  const before = beforeCommands(config, name).map((args) => ({
    title: `kit ${args.join(' ')}`,
    cmd: [...self, ...args, ...(ctx.flags.yes ? ['--yes'] : [])],
  }))

  if (ctx.flags.dryRun) {
    const plan = [
      ...before.map((b) => b.title),
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
  let comment: CommentOutcome | undefined
  if (opts.comment) {
    comment = url
      ? await commentOnPr(ctx, root, branch, name, previewComment({ target: name, url, version, env }))
      : 'no-url'
    if (comment === 'failed') process.exitCode = ExitCode.failed
  }
  if (ctx.flags.json) {
    emitJson({
      target: name,
      env,
      url: url ?? null,
      version: version ?? null,
      alias,
      ...(comment ? { comment } : {}),
    })
  } else if (url) {
    process.stdout.write(`${url}\n`)
  }
}
