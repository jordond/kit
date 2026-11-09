export const ExitCode = {
  ok: 0,
  failed: 1,
  usage: 2,
  config: 3,
  precondition: 4,
  interrupted: 130,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

export class KitError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode: ExitCode = ExitCode.failed,
  ) {
    super(message)
    this.name = 'KitError'
  }
}
