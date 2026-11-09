import { defineCommand } from '../cli/command'

export default defineCommand({
  description: 'Lint every target',
  group: 'Quality',
  args: {
    staged: { type: 'boolean', description: 'Only staged files' },
    fix: { type: 'boolean', description: 'Apply fixes' },
  },
  run(ctx) {
    // Phase 0: no-op used by the S1 startup benchmark.
    if (ctx.flags.json) process.stdout.write(`${JSON.stringify({ ok: true, targets: [] })}\n`)
  },
})
