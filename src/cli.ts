export {}

// Entry point. Decide colour before any colour library (picocolors, listr2) is imported:
// human output goes to stderr, so colour follows stderr's TTY, NO_COLOR, TERM=dumb and --no-color.
const argv = process.argv
const noColorFlag = argv.includes('--no-color')
if (noColorFlag) argv.splice(argv.indexOf('--no-color'), 1)
if (!process.env.FORCE_COLOR && (noColorFlag || !process.stderr.isTTY || process.env.TERM === 'dumb')) {
  process.env.NO_COLOR = '1'
}
await import('./cli/main')
