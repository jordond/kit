import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: [
    {
      entry: ['src/cli.ts', 'src/index.ts'],
      format: 'esm',
      platform: 'node',
      fixedExtension: false,
      outDir: 'dist',
      dts: true,
      deps: { neverBundle: [/^bun:/, 'bun'] },
    },
    {
      entry: { 'shots-page': 'src/lib/storeshots/page/main.ts' },
      format: 'esm',
      platform: 'browser',
      outDir: 'dist',
      dts: false,
      clean: false,
    },
  ],
})
