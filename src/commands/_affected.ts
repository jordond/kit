import type { Args } from 'gunshi'

/** `--affected [--base <ref>]`, shared by lint, format, typecheck, check, test and build. */
export const affectedArgs = {
  affected: {
    type: 'boolean',
    description: 'Only targets changed since the base (commits, staged, unstaged and untracked files)',
  },
  base: {
    type: 'string',
    description: 'Ref --affected compares against (default: origin/<default branch>, then main)',
  },
} as const satisfies Args
