export {}

// Entry point. Handles the flags that must act before anything loads:
// - colour is decided before any colour library (picocolors, listr2) is imported. Human output goes to
//   stderr, so colour follows stderr's TTY, NO_COLOR, TERM=dumb and --no-color.
// - --cwd changes directory before the project root is found.
// - --no-input becomes KIT_NO_INPUT so child kit processes (deploy.before) inherit it.
const argv = process.argv
const stop = argv.indexOf('--')
const take = (flag: string, withValue = false): string | true | undefined => {
  for (let i = 2; i < (stop < 0 ? argv.length : stop); i++) {
    const a = argv[i]!
    if (a === flag) {
      const value = withValue ? argv[i + 1] : undefined
      argv.splice(i, withValue ? 2 : 1)
      return withValue ? value : true
    }
    if (withValue && a.startsWith(`${flag}=`)) {
      argv.splice(i, 1)
      return a.slice(flag.length + 1)
    }
  }
  return undefined
}

const noColor = take('--no-color')
if (!process.env.FORCE_COLOR && (noColor || !process.stderr.isTTY || process.env.TERM === 'dumb')) {
  process.env.NO_COLOR = '1'
}
if (take('--no-input')) process.env.KIT_NO_INPUT = '1'
const cwd = take('--cwd', true)
if (typeof cwd === 'string') {
  process.chdir(cwd)
  delete process.env.KIT_ROOT
}
await import('./cli/main')
