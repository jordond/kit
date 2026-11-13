# Env

One `.env` per repo; `env.schema` (a zod object, usually `.kit/env.ts`) declares each key, and
`env.workerSecrets` / `env.githubSecrets` say which remotes hold it. Keys are secret unless marked
`.meta({ secret: false })`. Values never reach output: only names and statuses are printed.

| Command                                  | Does                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit env push`                           | Every worker in `env.workerSecrets` (`wrangler secret put`) and `env.githubSecrets` (`gh secret set`); lists names, confirms (`--yes` skips), `--dry-run` only lists |
| `kit env push --workers`                 | Every worker, GitHub skipped. Exclusive with `--all`, `--target` and `--github`                                                                                      |
| `kit env push --target <t>` / `--github` | One worker / GitHub only; both flags together push that worker and GitHub                                                                                            |
| `kit env rotate <KEY...> [--push]`       | New generated value in `.env`, outputs re-rendered as `kit env sync` does, then prints where the key lives and the `kit env push …` to run; `--push` runs it         |

`kit env rotate` only takes keys whose schema says how to make them:

```ts
INTERNAL_API_SECRET: z.string().min(32).meta({ generate: 'hex' }),             // 32 random bytes, hex
SESSION_KEY: z.string().meta({ generate: 'base64url', length: 48 }),           // length is in bytes
INSTALL_ID: z.uuid().meta({ generate: 'uuid' }),
```

- The new value is checked against the key's own rule before anything is written; only that line of
  `.env` changes (comments, order, quotes and line endings stay), and a key `.env` lacks is added.
- kit reads `.env` the way dotenv and Bun do: on an unquoted value ` #` starts a comment
  (`KEY=value # note` is `value`, `KEY= # note` is empty), a `#` inside `'…'`, `"…"` or backticks is
  part of the value, `"…"` turns `\n` / `\r` into line breaks, and `\$` is a literal `$`. kit itself
  never expands `$NAME`, but Bun (which loads `.env` before kit starts) does, so write a literal
  dollar as `\$`.
- When kit writes a value (`env init`, `env rotate`, rendered outputs) it quotes one that holds a
  `#`, has spaces at either end or starts with a quote, writes a multi-line value as `"…\n…"`, and in
  `.env` writes `$` as `\$` (`.dev.vars` keeps `$` raw: wrangler does not expand there). It refuses
  (exit 3, naming the key) a value no reader would get back intact: one that needs quotes and holds
  `'`, `"` and a backtick or ends in a backslash, a multi-line value holding `"` or a literal `\n`,
  and in `.env` one ending in `\$`. Base64-encode such a value.
- `kit env check`, `kit env push` and `kit doctor` warn about hand-written `.env` lines that Bun, dotenv
  and kit read differently (names and line numbers only): a `#` inside an unquoted value, an unescaped
  `$`, a quote that does not close on its line. What runs locally and what `kit env push` sends could
  differ there; the warning says how to write the line. `kit env check --json` lists them under
  `ambiguous`.
- It confirms first, since the old value stops working once the new one is pushed (`--yes` skips).
  `--dry-run` writes nothing and lists what would rotate and where it would be pushed.
- `--push` pushes every secret of the remotes that hold the key. The remotes are listed first (a
  remote kit cannot list stops the run, with `--yes` too) and one confirm covers rotating and pushing,
  so nothing is written until the push can go ahead.
- `--json` reports `{ rotated: [{ key, destinations }], pushed }`, never a value. When `.env` holds
  a new value that is not on its remotes yet, `pending` is the command that finishes the job; the
  same note goes to stderr.
- A key without `generate` belongs to a provider: rotate it there, update `.env`, then `kit env push`.
