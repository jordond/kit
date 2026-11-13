import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

// The kit server `bun run dev:studio` starts. `/api` is proxied to it, so the editor's relative
// `api/...` URLs resolve the same under the dev server as under the built page.
const port = process.env.KIT_STUDIO_PORT ?? '4317'

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
    proxy: { '/api': `http://127.0.0.1:${port}` },
  },
})
