# Changelog

```sh
kit changelog                              # Markdown since the last release tag
kit changelog --platform ios               # since the last ios/v* tag
kit changelog --from v0.5.0 --to v0.6.0 --json
kit changelog --platform android --write   # add a section to CHANGELOG.md
kit changelog --write docs/CHANGES.md
```

Groups the Conventional Commits in the range into Breaking (`!` or a `BREAKING CHANGE:` footer),
Features, Fixes, Performance and Other. `chore(release)` and merge commits are always left out;
`chore`, `test`, `ci` and `style` too unless `--all` is given. The range starts at the newest release
tag reachable from `--to` (`<platform>/v*` with `--platform`, any `…v<version>` tag without); with no
tag it is the whole history. `--to <tag>` lists that release: the range starts at the tag before it.

`--write` puts a `## <version> (<date>)` section above the newest one in `CHANGELOG.md` (or the file
named after it), creating the file when needed. The version is the `--to` tag's, else the platform's
version in the catalog TOML, else the root `package.json` version, else `Unreleased`; with `--platform`
the heading is `## ios 1.4.0 (…)`. A version that already has a section is not added again; the
`Unreleased` section is rewritten in place on each run, so new commits keep landing in it.

In a shallow clone with no release tag in it (CI's default checkout) the range would be whatever was
fetched: `kit changelog` warns, and `--write` refuses (exit 4) until the history is there
(`git fetch --unshallow --tags`, or `fetch-depth: 0`). Any other git failure (a ref that does not
exist, not a repository) is an error, never an empty changelog.
`--json` prints `{ from, to, sections: [{ title, commits }] }`.
