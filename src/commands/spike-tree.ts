import { defineCommand } from '../cli/command'

/** S6: prompts collected first, then a listr2 tree, all on stderr; --json result on stdout. */
export default defineCommand({
  description: 'S6 spike: task tree + prompts on stderr',
  group: 'Spike',
  args: {
    fail: { type: 'boolean', description: 'Make one step fail' },
  },
  async run(ctx) {
    const clack = await import('@clack/prompts')
    const { runSteps } = await import('../lib/steps')
    const { emitJson } = await import('../lib/log')
    const out = { output: process.stderr }

    let track = 'internal'
    if (ctx.flags.interactive) {
      clack.intro('kit · spike tree', out)
      const answer = await clack.select({
        message: 'Track?',
        options: [
          { value: 'internal', label: 'internal' },
          { value: 'beta', label: 'beta' },
        ],
        ...out,
      })
      if (clack.isCancel(answer)) process.exit(130)
      track = answer
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const results = await runSteps(
      [
        {
          title: 'biome check',
          task: async (update) => {
            for (const f of ['a.ts', 'b.ts', 'c.ts']) {
              update(`checking ${f}`)
              await sleep(150)
            }
          },
        },
        {
          title: 'spotlessCheck',
          task: async (update) => {
            update('> Task :shared:spotlessKotlinCheck')
            await sleep(300)
            if (ctx.args.fail) throw new Error('spotless found 2 violations')
          },
        },
        { title: 'typecheck', task: async () => void (await sleep(200)) },
      ],
      ctx.flags,
    )

    if (ctx.flags.interactive) clack.outro(`done · ${track}`, out)
    if (ctx.flags.json) emitJson({ track, results })
    if (results.some((r) => !r.ok)) process.exitCode = 1
  },
})
