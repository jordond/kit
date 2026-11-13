# Doctor

`kit doctor` checks the tools the config needs. Two checks only warn, because they are per-machine setup:
a repo with `mise.toml` warns when mise isn't installed or a pinned version differs, and a repo with
`lefthook.yml` warns when lefthook isn't installed or `lefthook install` hasn't been run in the clone.

When the config has a `shots` block, `kit doctor` also checks for Chrome, which `kit shots export` and `kit shots pages` use to render store artwork. It warns if Chrome or Chromium is missing or older than 112; install Google Chrome or set `KIT_CHROME` to a Chrome or Chromium binary.

```sh
kit doctor --fix             # list the fixes, confirm once, apply, check again
kit doctor --fix --yes       # no question (needed without a terminal)
kit doctor --fix --dry-run   # list them only
```

`--fix` repairs what is safe and local, runs the touched checks again, then reports (and exits on)
the state after the fixes. A fix is "fixed" only when its check passes afterwards: a command that ran
and left the check failing (tools `mise install` put somewhere this shell does not look yet) is
reported as applied, with the next step.

| Check                                   | Fix                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| lefthook hook not installed             | `lefthook install`                                                                                                            |
| mise tool missing or drifted            | `mise install`                                                                                                                |
| wrangler not installed                  | the worker's install: the package manager of the nearest lockfile above the worker dir, run where that lockfile is            |
| iOS / Android version drift             | writes the TOML version to the xcconfig's `MARKETING_VERSION` / the module.yaml's `versionName`                               |
| Kotlin toolchain wrapper not executable | `chmod +x`                                                                                                                    |
| workflow pins behind the npm pin        | moves them to that release's tag commit, as `kit upgrade` does; skipped with a note when the tag cannot be resolved (offline) |

Xcode, the JDK, the Android SDK, logins, `.env` values and secrets are never fixed: those checks keep
their hint. Plain `kit doctor` ends with `N fixable with kit doctor --fix` when there is something to
apply, and `--json` adds `fixes: [{ id, description, applied, ok, error?, hint? }]`, where `ok` is whether
the check passes after the fix.
