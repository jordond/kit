# Cloudflare workers

For targets of kind `worker`. Every command runs wrangler from the target's directory with
`CLOUDFLARE_ACCOUNT_ID` pinned from `cloudflare.accountId`.

| Command                                              | Does                                                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit deploy <target> --preview [--comment]`          | `wrangler versions upload`: a new version, production traffic untouched. The preview URL is the only thing on stdout (`--json`: `{ ok, target, url, version }`) |
| `kit release rollback <service> [--to <version-id>]` | `wrangler rollback` to the last deployment with different code, for a service whose `deploy` is `kit deploy <worker target>`; confirms first (`--yes` skips)    |
| `kit logs <target> [-- <wrangler tail flags>]`       | `wrangler tail`, attached to the terminal; Ctrl-C stops                                                                                                         |
| `kit open <target> [--print]`                        | The worker's Cloudflare dashboard page; `--print` or `--json` writes the URL instead                                                                            |
| `kit db backup [--remote] [--out <file>]`            | `wrangler d1 export` to `backups/<db>-<UTC timestamp>.sql`; prints the path                                                                                     |
| `kit db restore <file> [--remote]`                   | Load a backup: locally it replaces the database; remotely the database must be empty                                                                            |
| `kit db seed [--remote]`                             | Run the file named by `cloudflare.d1.<db>.seed` (relative to the repo root)                                                                                     |
| `kit db reset`                                       | Local only: delete the local database, re-apply migrations, then seed if configured                                                                             |

- `--preview` takes one worker target, honours `--env` and `deploy.before`, and aliases the preview
  to the branch (`feat/login` → `feat-login-<worker>.<subdomain>.workers.dev`); with no usable branch
  name the URL is the per-version one. A target with a custom `deploy` command runs its `build`
  first (and needs one: exit 2 otherwise); `deploy: false` has no preview.
- `--comment` posts the URL on the branch's pull request with `gh`, and on the next preview updates
  that comment: only one the `gh` user wrote that opens with kit's marker. With no pull request it
  warns; any other `gh` failure exits 1, after the URL is printed (`comment: 'failed'`, `ok: false`).
- `kit release rollback` works out the version itself: every `wrangler secret put` (`kit env push`)
  is a deployment, so "the previous deployment" would only undo the last secret. kit picks the last
  deployment whose code differs from what is live, shows its id and date, and warns when secrets
  changed since then: their values go back too, so run `kit env push` afterwards. `--to` names a
  version outright, and is required while a gradual deployment is live (exit 4 lists the candidates). Git tags are never moved or deleted: it names the `<service>/v*` tag that no
  longer matches production. A service whose deploy is not a worker exits 2.
- `kit db restore`: a backup carries the schema and the applied-migrations table, so it loads into
  an empty database only. Locally kit deletes the database first (after a confirm, like `reset`).
  Remotely it checks the database has no tables and exits 4 naming them if it does; kit never drops
  remote tables.
- `kit db backup` warns when git does not ignore the file it wrote: a `--remote` dump is production
  data. `kit init` adds `backups/` to `.gitignore`.
- `kit db reset` and a local restore stop (exit 1, "layout not recognised") rather than report a
  reset that deleted nothing, when wrangler's local state is not where kit expects it.
- `kit db` commands take `--db`; `--remote` writes (`restore`, `seed`) confirm first, and
  `kit db reset --remote` is a usage error.
- `kit logs` has no `--json` document (exit 2): for JSON lines use `kit logs <target> -- --format json`.
- `--dry-run` runs nothing in any of them.
