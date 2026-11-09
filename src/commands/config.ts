import { defineCommand } from '../cli/command'
import { emitJson } from '../lib/log'

export default defineCommand({
  description: 'Print the resolved kit.config.ts',
  group: 'Setup',
  run(ctx) {
    emitJson({ root: ctx.root ?? null, config: ctx.config ?? null })
  },
})
