import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

// `bun run dev:studio` starts a kit studio server and sets these. Its routes sit under a random
// path token, so `/api` is proxied to `<origin>/<token>/api`: the editor's relative `api/...` URLs
// then resolve the same under the dev server as under the built page.
const origin = process.env.KIT_STUDIO_ORIGIN ?? 'http://127.0.0.1:4317'
const token = process.env.KIT_STUDIO_TOKEN ?? ''

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative, so the built page works under the server's random path token.
  base: './',
  build: {
    // Outside the package root: the root `pack` step owns the rest of `dist` and runs first.
    outDir: '../dist/shots-editor',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: origin, rewrite: (path) => (token ? `/${token}${path}` : path) },
    },
  },
})
