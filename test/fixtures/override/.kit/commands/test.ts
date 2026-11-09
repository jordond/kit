// The README pattern: wrap the built-in `kit test` and drop linker noise from its output.
// (A real repo imports defineCommand from '@jordond/kit'; the fixture is copied to a temp dir, so it
// only takes the type from kit's sources.)
import type { KitCommand } from '../../../../../src/index'

const LINKER_NOISE = /\/Users\/distiller\/project\/kn-(core|ui)\/|built with -gmodules/

export default {
  description: 'Run the test suites (linker noise muted)',
  override: true,
  args: {},
  async run(ctx) {
    ctx.log.step('wrapped')
    await ctx.builtin('test', { mute: LINKER_NOISE })
  },
} satisfies KitCommand
