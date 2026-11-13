import { defineConfig } from 'vite-plus'

// Everything is linted and formatted except generated output, Gradle and fastlane sources,
// `kit init` template files that are not ours to reformat, and local notes.
const ignorePatterns = [
  'dist/**',
  'gradle/**',
  'fastlane/**',
  'templates/**',
  'renovate/**',
  '.claude/**',
  'scratchpad/**',
  // Fixtures are inputs the tests compare byte for byte.
  'test/fixtures/**/*.md',
  'test/fixtures/**/*.yaml',
  'test/fixtures/**/*.yml',
  'test/fixtures/**/*.toml',
  'test/fixtures/**/*.jsonc',
]

export default defineConfig({
  fmt: {
    ignorePatterns,
    printWidth: 110,
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    sortPackageJson: false,
    overrides: [
      {
        // The editor's classes are Tailwind's; sort them the way the Tailwind plugin does.
        files: ['editor/**'],
        options: { sortTailwindcss: { stylesheet: './editor/src/index.css', functions: ['clsx', 'cn'] } },
      },
    ],
  },
  lint: {
    ignorePatterns,
    options: { typeAware: true, typeCheck: true },
    rules: {
      // kit narrows with `!` after its own checks, and tests lean on it.
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
        files: ['editor/**'],
        plugins: ['react'],
        env: { browser: true },
        rules: {
          // React 17+ transform: no `import React`.
          'react/react-in-jsx-scope': 'off',
        },
      },
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
