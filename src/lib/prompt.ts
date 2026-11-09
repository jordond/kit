import type { Flags } from '../cli/command'
import { ExitCode, KitError } from './errors'

/**
 * clack prompts on stderr, TTY and CI aware (brewd `lib/prompt.ts`, ported).
 * Without a terminal kit never prompts: confirmations error with a `--yes` hint, input prompts
 * error naming what to set instead. Collect answers before starting a steps tree, never during.
 */

type PromptFlags = Pick<Flags, 'interactive' | 'yes'>

const out = { output: process.stderr }

/**
 * A prompt can land after a minutes-long step; whatever was typed meanwhile is still queued in the
 * tty and would be read as the answer. Discard it before asking.
 */
async function drainTypeahead(): Promise<void> {
  const stdin = process.stdin
  if (!stdin.isTTY) return
  const discard = (): void => {}
  stdin.setRawMode(true)
  stdin.on('data', discard)
  stdin.resume()
  await Bun.sleep(50)
  stdin.off('data', discard)
  stdin.pause()
  stdin.setRawMode(false)
}

function cancelled(): never {
  throw new KitError('Cancelled', undefined, ExitCode.interrupted)
}

function noTty(what: string, hint: string): never {
  throw new KitError(`Cannot ${what} without a terminal`, hint, ExitCode.usage)
}

/** Yes/no. `--yes` answers yes (unless `force` is set, for prod). */
export async function confirm(
  flags: PromptFlags,
  message: string,
  opts: { initial?: boolean; force?: boolean } = {},
): Promise<boolean> {
  if (flags.yes && !opts.force) return true
  if (!flags.interactive) noTty('confirm', opts.force ? 'Run it from a terminal' : 'Re-run with --yes')
  const clack = await import('@clack/prompts')
  await drainTypeahead()
  const answer = await clack.confirm({ message, initialValue: opts.initial ?? false, ...out })
  if (clack.isCancel(answer)) cancelled()
  return answer
}

export async function text(
  flags: PromptFlags,
  message: string,
  opts: {
    initial?: string
    placeholder?: string
    hint?: string
    validate?: (v: string) => string | undefined
  } = {},
): Promise<string> {
  if (!flags.interactive) noTty(`ask "${message}"`, opts.hint ?? 'Pass the value as a flag')
  const clack = await import('@clack/prompts')
  await drainTypeahead()
  const answer = await clack.text({
    message,
    initialValue: opts.initial,
    placeholder: opts.placeholder,
    validate: opts.validate ? (v) => opts.validate!(v ?? '') : undefined,
    ...out,
  })
  if (clack.isCancel(answer)) cancelled()
  return answer
}

/** Masked input for secrets. The value is never echoed. */
export async function password(
  flags: PromptFlags,
  message: string,
  opts: { hint?: string; validate?: (v: string) => string | undefined } = {},
): Promise<string> {
  if (!flags.interactive) noTty(`ask for ${message}`, opts.hint ?? 'Set it in .env')
  const clack = await import('@clack/prompts')
  await drainTypeahead()
  const answer = await clack.password({
    message,
    validate: opts.validate ? (v) => opts.validate!(v ?? '') : undefined,
    ...out,
  })
  if (clack.isCancel(answer)) cancelled()
  return answer
}

export async function select<T extends string>(
  flags: PromptFlags,
  message: string,
  options: { value: T; label?: string; hint?: string }[],
  opts: { initial?: T; hint?: string } = {},
): Promise<T> {
  if (!flags.interactive) noTty(`ask "${message}"`, opts.hint ?? 'Pass the value as a flag')
  const clack = await import('@clack/prompts')
  await drainTypeahead()
  // clack's Option<T> type is conditional on T; the shape above matches it at runtime.
  const answer = await clack.select<T>({
    message,
    options: options as Parameters<typeof clack.select<T>>[0]['options'],
    initialValue: opts.initial,
    ...out,
  })
  if (clack.isCancel(answer)) cancelled()
  return answer as T
}
