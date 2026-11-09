import { defineCommand } from '../cli/command'

/** Shells `kit completion` writes a script for. */
export const SHELLS = ['zsh', 'bash', 'fish'] as const

/**
 * `kit completion <shell>` prints the script; main.ts runs the completion plugin for a known shell
 * (and for the script's own `kit complete -- <words>` callback) before this command loads. `run`
 * only sees a missing or unknown shell.
 */
export default defineCommand({
  description: 'Print a shell completion script',
  group: 'Setup',
  args: {
    shell: { type: 'positional', required: true, description: 'zsh, bash or fish' },
  },
  examples: [
    '# zsh: add to ~/.zshrc (after compinit)',
    'source <(kit completion zsh)',
    '# bash: add to ~/.bashrc',
    'source <(kit completion bash)',
    '# fish',
    'kit completion fish > ~/.config/fish/completions/kit.fish',
  ].join('\n'),
  async run(ctx) {
    const { ExitCode, KitError } = await import('../lib/errors')
    const shell = ctx.args.shell
    throw new KitError(
      `Unknown shell "${shell}"`,
      `Use one of: ${SHELLS.join(', ')}. Run \`kit completion --help\` for setup`,
      ExitCode.usage,
    )
  },
})
