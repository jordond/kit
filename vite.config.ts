import { defineConfig } from 'vite-plus'

// Only src, test and the root JSON files are linted and formatted; the rest is generated output,
// Gradle and fastlane sources, or `kit init` template files that are not ours to reformat.
const ignorePatterns = [
  'dist/**',
  'gradle/**',
  'fastlane/**',
  'templates/**',
  'renovate/**',
  '.claude/**',
  // Biome never formatted these; oxfmt would, and fixtures must stay byte-for-byte what tests expect.
  '**/*.md',
  '**/*.yaml',
  '**/*.yml',
  '**/*.toml',
  // oxfmt adds trailing commas to .jsonc; wrangler and kit read these files as they are written.
  '**/*.jsonc',
]

export default defineConfig({
  fmt: {
    ignorePatterns,
    printWidth: 110,
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns,
    options: { typeAware: true, typeCheck: true },
    rules: {
      // Biome had this off too: kit narrows with `!` after its own checks, and tests lean on it.
      'typescript/no-non-null-assertion': 'off',
      // `...[a, b]` is how long argv and language lists are wrapped under the 110-column width.
      'unicorn/no-useless-spread': 'off',
      // `string | 'manual'` and `unknown | Promise<unknown>` are written on purpose, to name the
      // special value or to say a command may be async; the rule would have them collapsed.
      'typescript/no-redundant-type-constituents': 'off',
      // `String(v)` on an unknown env or schema value is the coercion kit wants, not an accident.
      'typescript/no-base-to-string': 'off',
    },
    overrides: [
      {
        files: ['test/**'],
        rules: {
          // bun:test types `expect(promise).rejects.toThrow()` as void, but it must be awaited.
          'typescript/await-thenable': 'off',
        },
      },
    ],
  },
  pack: [
    {
      entry: ['src/cli.ts', 'src/index.ts'],
      format: 'esm',
      platform: 'node',
      // Keep `.js`: bin/kit and `exports` point at dist/cli.js and dist/index.js.
      fixedExtension: false,
      outDir: 'dist',
      dts: true,
      // bun:* modules and the bun types package exist only under Bun.
      deps: { neverBundle: [/^bun:/, 'bun'] },
    },
    {
      entry: { 'shots-page': 'src/lib/storeshots/page/main.ts' },
      format: 'esm',
      platform: 'browser',
      outDir: 'dist',
      dts: false,
      // The first config already emptied dist.
      clean: false,
    },
  ],
})
