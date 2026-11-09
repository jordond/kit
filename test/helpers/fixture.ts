import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const KIT = resolve(import.meta.dir, '../..')

export interface Call {
  bin: string
  argv: string[]
  cwd: string
}

export interface Fixture {
  dir: string
  /** Run kit from source in the fixture (or `cwd` inside it). */
  kit(
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{
    code: number
    stdout: string
    stderr: string
  }>
  /** Recorded calls to the fake binaries, in order. */
  calls(): Call[]
  /** Make a fake binary exit with `code` (and print `output`). */
  fail(bin: string, code?: number, output?: string): void
  /** Replace a fake binary's body (sh). */
  script(bin: string, body: string): void
  /** Start kit without waiting; for signal tests. */
  spawn(args: string[]): Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  cleanup(): void
}

/**
 * Copy `test/fixtures/<name>` to a temp dir and put recording fakes on PATH for `bins`.
 * Each fake appends `{bin, argv, cwd}` as a JSON line to calls.log and exits 0 (or as `fail` says).
 */
export function fixture(name: string, bins: string[]): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `kit-${name}-`))
  cpSync(join(KIT, 'test/fixtures', name), dir, { recursive: true })
  const binDir = join(dir, '.fakebin')
  mkdirSync(binDir)
  const log = join(dir, '.calls.log')
  writeFileSync(log, '')
  for (const bin of bins) {
    const file = join(binDir, bin)
    writeFileSync(
      file,
      `#!/bin/sh
f="${binDir}/${bin}.fail"
printf '%s\\n' "$(bun -e 'console.log(JSON.stringify({bin:process.argv[1],argv:process.argv.slice(2),cwd:process.cwd()}))' "${bin}" "$@")" >> "${log}"
if [ -f "$f" ]; then cat "$f.out" 2>/dev/null; exit "$(cat "$f")"; fi
echo "${bin} ok"
`,
    )
    chmodSync(file, 0o755)
  }
  // `bun x <bin>` resolves node_modules/.bin first; keep it from downloading anything.
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  for (const bin of bins) symlinkSync(join(binDir, bin), join(dir, 'node_modules/.bin', bin))
  return {
    dir,
    async kit(args, opts = {}) {
      const proc = Bun.spawn(['bun', '--no-env-file', join(KIT, 'src/cli.ts'), ...args], {
        cwd: opts.cwd ? join(dir, opts.cwd) : dir,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CI: 'true',
          NO_COLOR: '1',
          KIT_ROOT: '',
          ...opts.env,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { code: await proc.exited, stdout, stderr }
    },
    calls() {
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const c = JSON.parse(l) as Call
          return { ...c, cwd: c.cwd.replace(/^\/private/, '').replace(dir.replace(/^\/private/, ''), '.') }
        })
    },
    fail(bin, code = 1, output = '') {
      writeFileSync(join(binDir, `${bin}.fail`), String(code))
      writeFileSync(join(binDir, `${bin}.fail.out`), output)
    },
    script(bin, body) {
      writeFileSync(join(binDir, bin), `#!/bin/sh\n${body}\n`)
    },
    spawn(args) {
      return Bun.spawn(['bun', '--no-env-file', join(KIT, 'src/cli.ts'), ...args], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CI: 'true',
          NO_COLOR: '1',
          KIT_ROOT: '',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
