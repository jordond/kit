/**
 * `bun run dev:studio`: the editor's Vite dev server in front of a real `kit shots studio`. The
 * studio server puts every route under a random path token, so this starts it first, reads the URL
 * it prints, and hands Vite the origin and the token (`KIT_STUDIO_ORIGIN`, `KIT_STUDIO_TOKEN`) for
 * its `/api` proxy (`editor/vite.config.ts`). Only for a source checkout: the published package
 * ships the built editor and needs neither.
 *
 * The studio serves the repo in `KIT_STUDIO_ROOT` (default: the shots fixture app).
 */

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const repo = process.env.KIT_STUDIO_ROOT ?? `${root}/test/fixtures/shots-app`

const server = Bun.spawn(['bun', `${root}/src/cli.ts`, 'shots', 'studio', '--no-open'], {
  cwd: repo,
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, KIT_DEV: root },
})

const children: Bun.Subprocess[] = [server]
const stop = (): void => {
  for (const child of children) child.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

/** Echoes a stream and resolves with the studio URL once it is printed. */
async function watch(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream): Promise<URL | undefined> {
  let found: URL | undefined
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const text = decoder.decode(chunk)
    out.write(text)
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s/]+\//)
    if (match && !found) {
      found = new URL(match[0])
      started(found)
    }
  }
  return found
}

let vite: Bun.Subprocess | undefined
function started(url: URL): void {
  if (vite) return
  vite = Bun.spawn(['vp', '-C', 'editor', 'dev'], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...process.env,
      KIT_STUDIO_ORIGIN: url.origin,
      KIT_STUDIO_TOKEN: url.pathname.replaceAll('/', ''),
    },
  })
  children.push(vite)
  void vite.exited.then(stop)
}

void watch(server.stdout, process.stdout)
void watch(server.stderr, process.stderr)

// The studio ending ends Vite too: a half-running studio only confuses.
await server.exited
stop()
