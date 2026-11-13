/**
 * `bun run dev:studio`: the editor's Vite dev server in front of a kit studio server on a fixed
 * port. Vite proxies `/api` to it (`vite.config.ts`). Only for a source checkout: the published
 * package ships the built editor and needs neither.
 *
 * Set `KIT_STUDIO_PORT` to move the API port, and `KIT_STUDIO_API=0` to start only Vite when a
 * studio server is already running there.
 */

const port = process.env.KIT_STUDIO_PORT ?? '4317'
const env = { ...process.env, KIT_STUDIO_PORT: port }
const root = new URL('..', import.meta.url).pathname

const children: Bun.Subprocess[] = []

if (process.env.KIT_STUDIO_API !== '0') {
  children.push(
    Bun.spawn(['bun', 'src/cli.ts', 'shots', 'studio', '--port', port, '--no-open'], {
      cwd: root,
      env,
      stdio: ['inherit', 'inherit', 'inherit'],
    }),
  )
}
children.push(
  Bun.spawn(['vp', '-C', 'editor', 'dev'], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit'] }),
)

const stop = (): void => {
  for (const child of children) child.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

// Either process ending ends the other: a half-running studio only confuses.
await Promise.race(children.map((child) => child.exited))
stop()
