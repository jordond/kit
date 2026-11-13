# Store screenshots

`kit shots export` turns the raw shots into the images the stores take: each slide of a saved project
(background, headline, device frame around the raw shot) is drawn by headless Chrome at the store's
exact size and written into the store listing dirs, ready for [`kit release metadata push --screenshots`](releases.md#store-listing).

```sh
kit shots ios && kit shots ipad && kit shots android   # capture the raw shots
kit shots export                                       # compose them, for both stores and every locale
kit shots export --store apple --locale en-US
kit shots export --out build/store-shots --dry-run --json
kit release metadata push ios --only-screenshots       # upload the images, leave the text (see Store listing)
```

```ts
shots: {
  project: 'brand/studio.json',          // the saved project: slides, text, frames
  raw: 'brand/screenshots',              // optional: default the shots suite's screenshots dir
  fonts: [{ family: 'Nunito', file: 'brand/fonts/nunito.woff2', weight: '400 800' }],
  brand: { mark: 'brand/logo.svg', wordmark: 'brewd', color: '#2c1e14', font: 'Nunito' },
  sets: { ios: 'iphone-6.9' },           // optional: iphone-6.9 | iphone-6.5 | iphone-6.3
  presets: { sand: { background: { primaryColor: '#f4ecd8' } } },   // optional: style presets for the studio
  palette: ['#2c1e14', '#f4ecd8'],       // optional: swatches beside the studio's colour controls
},
```

**Artwork pages.** `kit shots pages [name...]` renders the HTML pages in `shots.pages` (the App Store
product page header and search results artwork, for example) with the same headless Chrome, at the pixel
size you declare and with the alpha channel flattened, which App Store Connect requires. It writes
`build/shots-pages/<name>-<width>x<height>.png` unless a page sets `out` or you pass `--out <dir>`. `--dry-run`
lists the files without starting Chrome; `--json` prints them on stdout. A page sets `scale` (default 2, so
a 3840x1646 page is laid out at 1920x823), and `background` for the colour under transparent areas. The repo
root is served locally (the page can read any non-dot file under it), so a page's relative assets load, and `shots.fonts` is available to every page. With
only `pages` set, `shots.project` may be left out. See [CONFIG.md](CONFIG.md#artwork-pages).

```sh
kit shots pages                      # every page
kit shots pages header --out build/artwork
```

```ts
shots: {
  pages: [{ name: 'header', file: 'brand/creative/header.html', width: 3840, height: 1646 }],
},
```

**The project file.** A version 1 project as the screenshot editor saves it: `slides[]`, each with a
`name`, an `order`, the `sourceFile` of its raw shot (`home.png`), its text, device and background. kit
ignores the editor's `imageSrc` and `dimensionId`. Every slide is exported for every target: the raw shot
is `<raw>/<target>/<locale>/<sourceFile>` when that exists, else `<raw>/<target>/<sourceFile>`, and a
slide framed in an iPhone gets the iPad or Pixel frame on the other targets. An optional `locales` block
replaces the text per locale and slide id; a field left out keeps the slide's own text, and `fr-CA`
falls back to another `fr` entry before that:

```json
"locales": { "fr-FR": { "slide-1": { "headline": "…", "subheadline": "…", "badge": "…" } } }
```

**Version 2 and `kit shots migrate`.** A version 2 project (`"version": 2`) holds the rules once: a
`style`, per-target `targets`, and slides of just `shot`, `headline` and what differs. Slide ids come from
the shot name (`01-you.png` is `you`), and `locales` is keyed by them. Version 1 files keep working.
`kit shots migrate` prints the version 2 file; `kit shots migrate --write` replaces `shots.project` once it
has proved that every target and locale draws the same slides (`--dry-run` only proves). The merge order,
derived fields and the file's shape are in [CONFIG.md](CONFIG.md#the-project-file).

**`kit shots studio`** edits the version 2 project in a browser, previewing with the same renderer the
export uses. It serves on `127.0.0.1` under a random path token and prints the URL (`--port` fixes the
port, `--no-open` leaves the browser alone). A version 1 project opens read-only with the migrate command
to run. Every edit is written at a scope: all slides, one target, one slide, or one slide on one target;
each control shows where its value comes from and can reset it, and a value equal to what the layers below
give removes the override, so the file stays small. Changes autosave (Cmd/Ctrl+S saves now, Cmd/Ctrl+Z
undoes); if the file changed on disk the editor asks whether to reload or overwrite. Slides are added from
the raw shots (a PNG can be uploaded into the raw dir), reordered by dragging and deleted, undoably. With
no project file it offers one slide per raw shot and writes nothing until you confirm.

In the studio, a slide whose text overflows (a headline past 3 lines, text off the canvas, or text that
pushes the device far down) gets a warning on the filmstrip and its target column, for any locale. Drag the
device on a canvas to place it, scroll or pinch over it to scale it, or nudge it with the arrow keys; the
expand button on a column shows that target at export size. The header's Export button runs `kit shots
export` for the stores and locale you pick (saving first) and shows what was written. The Presets group
applies a built-in look (`light`, `dark`, `bold-colour`) or one from `shots.presets` in one undoable edit,
and `shots.palette` puts your brand colours beside every colour control. See
[CONFIG.md](CONFIG.md#shots).

**Fonts and brand.** Every font family a slide names has to be in `shots.fonts` (the CSS generics
`sans-serif`, `serif`, `monospace` and `system-ui` aside): Chrome would draw an unknown family in a
fallback font without complaint, so export stops first (exit 3). `brand` is the lockup drawn on slides
that show it: the mark, and the wordmark beside it. The wordmark and a slide's badge are drawn in
`brand.font`, or in the slide's headline family when there is none, so that family has to be declared
even on a slide whose headline is empty.

**Output.** Locales are, per store, the locale dirs already in that store's metadata dir (`en-US` when
there are none yet); `--locale` narrows them. In the iOS metadata dir, the dirs deliver does not read
as a locale are left out (`default`, `review_information`, `trade_representative_contact_information`,
`app_clip_review_information`, `android`, `fonts`, `appleTV`, `iMessage`), and in either store so is a
dir whose name cannot be a locale (`Old Backup`).

| Store  | Target  | Size                     | Written to                                                                  |
| ------ | ------- | ------------------------ | --------------------------------------------------------------------------- |
| apple  | ios     | 1320x2868 (`iphone-6.9`) | `<release.ios.metadata>/../screenshots/<locale>/NN_iphone-6.9_<slug>.png`   |
| apple  | ipad    | 2064x2752 (`ipad-13`)    | same dir, `NN_ipad-13_<slug>.png`                                           |
| google | android | 1440x2560 (`phone`)      | `<release.android.metadata>/<locale>/images/phoneScreenshots/NN_<slug>.png` |

`NN` is the slide's position and `<slug>` its name. Each dir gets a `.kit-shots.json` listing what
export wrote. The next export replaces those files and removes the ones it no longer writes; an image
in the same set that it did not write is in the way (exit 4) until it is moved or `--force` replaces it.
So is a directory or a dangling link with an image name there: the uploader would take it and fail.
Play's icon, feature graphic and other screenshot types are never touched. The PNGs have no alpha
channel, which App Store Connect requires.

| Flag                          | Meaning                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--store apple\|google\|both` | Default `both`. A store with no `release.<platform>.metadata` is a usage error unless `--out` is given         |
| `--locale <a,b>`              | Only these locales                                                                                             |
| `--out <dir>`                 | Write `<dir>/apple/<locale>/…` and `<dir>/google/<locale>/images/phoneScreenshots/…` instead of the store dirs |
| `--allow-missing`             | Skip a slide whose raw shot is absent, instead of stopping (exit 4)                                            |
| `--force`                     | Replace images in an exported set that kit did not write                                                       |
| `--dry-run`                   | Print what would be written and removed; Chrome is not started and nothing changes                             |
| `--json`                      | `{ dryRun, stores, written: [{ store, target, set, locale, slide, file, width, height }], removed, skipped }`  |

`--store`, `--locale` and `--out` given an empty or whitespace-only value (`--out "$OUT"` with `OUT`
unset) are a usage error (exit 2), not the default.

Nothing is written unless every image came back at its exact size: a Chrome that exits, a page error or
five minutes without a new image is exit 1 with the store dirs as they were. Every rendered PNG is held
in memory until all of them are back, so memory grows with slides x locales (a few MB each); `--store`
and `--locale` split a large export into smaller runs. Before Chrome starts, export checks
that the raw shots, font and brand files are there, that Chrome is, and that no set has more slides
than its store keeps (10 on the App Store, 8 on Play); each of those is exit 4. Chrome is the installed
Google Chrome or Chromium (112 or newer), or the binary `KIT_CHROME` names.
