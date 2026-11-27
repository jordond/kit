# Store screenshots

`kit shots export` turns the raw shots into the images the stores take: each slide of a saved project
(background, headline, device frame around the raw shot), or each [HTML slide](#html-slides) you write
yourself, is drawn by headless Chrome at the store's exact size and written into the store listing dirs, ready for [`kit release metadata push --screenshots`](releases.md#store-listing).

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

**HTML slides.** When a design needs more than the studio's slide (bands that run off the edge, tilted
stickers, one coloured word), write each slide as an HTML page and list them in `shots.slides` instead of
`shots.project`. `kit shots export` then renders every slide, in config order, for every exported set and
locale, and writes them under the same file names, with the same flags and the same ownership rules as
project slides: dropping a slide from the config removes its file at the next export.

```ts
shots: {
  slides: [
    { name: 'shelf', file: 'brand/store/01-shelf.html', shot: '01-shelf', background: '#ffd400' },
    { name: 'playing', file: 'brand/store/02-playing.html', shot: '02-playing' },
  ],
  suites: ['shots', 'shots-shelf'],      // optional: the suites `kit shots <target>` runs (see Maestro)
  fonts: [{ family: 'Nunito', file: 'brand/fonts/nunito.woff2', weight: '400 800' }],
},
```

`shot` is the raw shot the slide shows: `<raw>/<target>/<locale>/<shot>` when that exists, else
`<raw>/<target>/<shot>` (`.png` is added to a name without an extension). A slide whose shot is absent stops
the export (exit 4) unless `--allow-missing`; a slide with no `shot` is drawn as is. `background` is the
colour under transparent areas, default `#ffffff`. Setting both `project` and `slides` is a config error:
the studio edits `project`, and the export renders one or the other.

kit tells the page what it is drawing, four ways, so one HTML file serves every set without guessing from
the viewport:

| Where                   | What                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<html data-kit-…>`     | `data-kit-set` (`ipad-13`), `-target` (`ios`, `ipad`, `android`), `-store`, `-locale`, `-slide`, `-index`, `-shot` (the shot's URL). Set before the body is parsed, so `html[data-kit-target='ipad'] .device { … }` works |
| `--kit-shot` on `:root` | `url(…)` of the raw shot, for `background-image: var(--kit-shot)`                                                                                                                                                         |
| `<img data-kit-shot>`   | Its `src` is replaced by the raw shot (and `srcset` dropped); write the tag plainly, with no `>` inside an attribute. Keep a `src` to a sample shot for opening the file by hand                                          |
| The query string        | `?set=…&target=…&store=…&locale=…&slide=…&index=…&shot=…`, for a script                                                                                                                                                   |

The page is served like an artwork page: from the repo root, with `shots.fonts` injected, so relative paths
into `brand/` keep working. The raw shot comes from kit's own route, so the raw dir may be gitignored or
under a dot dir.

**Sizing.** Each slide is shot at its set's pixel size (1320x2868, 2064x2752, 1440x2560 by default). kit
picks the device scale factor: the largest whole number up to 4 that divides both sides and keeps the CSS
viewport at least 500 px wide, because headless Chrome makes no narrower window. That gives:

| Set          | Pixels    | Scale | CSS viewport |
| ------------ | --------- | ----- | ------------ |
| `iphone-6.9` | 1320x2868 | 2     | 660x1434     |
| `iphone-6.5` | 1284x2778 | 2     | 642x1389     |
| `iphone-6.3` | 1206x2622 | 2     | 603x1311     |
| `ipad-13`    | 2064x2752 | 4     | 516x688      |
| `phone`      | 1440x2560 | 2     | 720x1280     |

Lay the page out against the viewport (`vw`, `vh`, or a fixed-width stage scaled with `zoom`), not against
these numbers. After the page loads, kit reads `innerWidth` and `innerHeight` back and fails the render
(exit 1, nothing written) when they are not the viewport it asked for. Chrome only brings the window to its
full height just before the shot, so prefer `data-kit-set` over media queries for anything that depends on
which set is drawn. kit's script in the page does the reporting and sets `data-kit-*`, so a slide whose
Content-Security-Policy blocks inline scripts fails; an artwork page in the same position only warns.
Each image is its own Chrome run, so an export takes a second or two per slide, set and locale; `--store`
and `--locale` narrow it.

**Foldable screenshots.** `shots.foldable.slides` adds Play's foldable set: HTML slides like `slides`,
each with an `aspect` (`1:1`, `4:3`, `10:16`, …) instead of a set, written to
`<locale>/images/foldableScreenshots/` with their own numbering and ownership. `data-kit-set` is
`fold-1x1`, `fold-4x3` and so on, and `data-kit-target` is `android`. Play wants 3 to 8, with at least
one unfolded 1:1, one unfolded 4:3 and one outer screen 10:16. Its API takes no foldable images, so upload
them by hand in Play Console. See [CONFIG.md](CONFIG.md#foldable-screenshots).

```ts
shots: {
  foldable: {
    slides: [
      { name: 'open', file: 'brand/store/fold/open.html', shot: 'fold-01-shelf', aspect: '1:1' },
      { name: 'wide', file: 'brand/store/fold/wide.html', shot: 'fold-02-player', aspect: '4:3' },
      { name: 'outer', file: 'brand/store/fold/outer.html', shot: 'outer-01-shelf', aspect: '10:16' },
    ],
  },
},
```

**Artwork pages.** `kit shots pages [name...]` renders the HTML pages in `shots.pages` (the App Store
product page header and search results artwork, for example) with the same headless Chrome, at the pixel
size you declare and with the alpha channel flattened, which App Store Connect requires. It writes
`build/shots-pages/<name>-<width>x<height>.png` unless a page sets `out` or you pass `--out <dir>`. `--dry-run`
lists the files without starting Chrome; `--json` prints them on stdout. A page sets `scale` (default 2, so
a 3840x1646 page is laid out at 1920x823), and `background` for the colour under transparent areas. `width / scale` must be at
least 500: headless Chrome makes no narrower window, so a smaller viewport is a config error that names the
scale to use, and a page Chrome lays out at any other size than asked fails the render. The repo
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

`NN` is the slide's position and `<slug>` its name (an HTML slide's `name`). Each dir gets a `.kit-shots.json` listing what
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
