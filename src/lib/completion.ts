import { join } from 'node:path'

/**
 * Installing shell completion from `kit init`. The script is written to a file once: fish autoloads
 * it; zsh and bash source it from the rc file. Nothing runs `kit` when a shell starts, so a new
 * terminal never executes the kit.config.ts of whatever repo it opens in.
 */

export type Shell = 'zsh' | 'bash' | 'fish'

export interface CompletionState {
  shell: Shell
  /** The script file init writes. */
  file: string
  /** The rc file that sources it (zsh, bash); fish needs none. */
  rc?: string
  /** Why it is not installed now; undefined installs it. */
  skip?: string
}

/** The user's shell from `$SHELL`, when kit has a completion script for it. */
export function shellOf(shellPath: string | undefined): Shell | undefined {
  const name = shellPath?.split('/').pop()
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : undefined
}

/**
 * Where completion goes. fish: its completions dir. zsh/bash: `<config>/kit/completion.<shell>`,
 * sourced from `.zshrc`, or from `.bash_profile` on macOS (Terminal starts login shells) and
 * `.bashrc` elsewhere.
 */
export function completionTargets(
  shell: Shell,
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform = 'linux',
): { script: string; rc?: string } {
  const config = env.XDG_CONFIG_HOME || join(home, '.config')
  if (shell === 'fish') return { script: join(config, 'fish/completions/kit.fish') }
  const script = join(config, 'kit', `completion.${shell}`)
  if (shell === 'zsh') return { script, rc: join(env.ZDOTDIR || home, '.zshrc') }
  return { script, rc: join(home, platform === 'darwin' ? '.bash_profile' : '.bashrc') }
}

/** The lines added to the rc file. zsh needs compinit before the script's `compdef`. */
export function rcSnippet(shell: Shell, script: string): string {
  const file = JSON.stringify(script)
  const load =
    shell === 'zsh'
      ? `(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }; source ${file}`
      : `source ${file}`
  return `# kit shell completion\n[ -f ${file} ] && { ${load}; }\n`
}

/**
 * Whether completion is already set up. `current` is the rc file's text (zsh, bash) or anything
 * defined when the fish file exists; a hand-added `source <(kit completion zsh)` counts.
 */
export function completionInstalled(current: string | undefined, rc: boolean): boolean {
  if (current === undefined) return false
  return rc ? /\bkit[ /]completion\b/.test(current) : true
}
