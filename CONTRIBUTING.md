# Contributing to kit

kit runs on Bun and is checked and built with [Vite+](https://viteplus.dev) (`vp`). `vp` is a Node
program, so a checkout needs Node `^22.18`, `^24.11` or `>=26` next to Bun; a globally installed `vp`
installs Node itself.

| Command              | Does                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bun run check`      | Format check, lint and type check in one pass (`vp check`); warnings fail                                  |
| `bun run format`     | Rewrite files with the formatter (`vp fmt`)                                                                |
| `bun run lint`       | Lint only (`vp lint`)                                                                                      |
| `bun test`           | Tests. They run on Bun, not on `vp test`                                                                   |
| `bun run build`      | Bundle `dist/` and its declarations (`vp pack`), then build the screenshot editor into `dist/shots-editor` |
| `bun run dev:studio` | The studio server on the shots fixture (`KIT_STUDIO_ROOT` picks another repo) plus the editor's dev server |
| `bun run test:pack`  | Install the packed tarball into a temp app and run it                                                      |

`KIT_DEV=<checkout>` makes the `kit` launcher run that checkout's sources.

The screenshot editor lives in `editor/` (React, built by `vp build`). It imports kit's renderer and
project code from `src/lib/storeshots` by relative path, so those files must stay free of Node and Bun
imports. `KIT_CHROME_TEST=1 bun test test/e2e/shots-editor.test.ts` checks the built editor in headless
Chrome; run `bun run build` first.

## Lane tests

The shared Fastfile's selection logic (which build a promotion moves, which Play release a rollout
changes, tester-group resolution) has Ruby tests that run it against stubbed store objects:

```sh
ruby test/fastlane/run.rb
```

They need only Ruby and its bundled minitest, not kit's fastlane bundle. `bun test` runs them too
(`test/e2e/fastlane-lanes.test.ts`), plus a `fastlane lanes` parse of the Fastfile when the bundle is
installed; each part is skipped when its tool is missing.
