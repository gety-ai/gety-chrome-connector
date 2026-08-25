# Google Chrome Connector for Gety

Indexes local Google Chrome profiles into Gety. By default, one connector
includes `Default`, `Profile 1`, `Profile 2`, and other numbered profiles found
in Chrome's user-data directory:

- **Bookmarks** — from the profile's `Bookmarks` JSON file, with folder
  breadcrumbs (`Bookmarks bar / design`) as searchable context.
- **Browsing history** — from the profile's `History` SQLite database (`urls`
  table), with a configurable scope.

Each document links back to the page URL (`doc_link → metadata.url`), so opening
a result launches it in the browser. Chrome does not store page body text, so
documents are searchable by **title, URL, and bookmark folder** — not full page
content.

## Documents

| Source   | `doc_type`        | `id`                                           | `doc_updated_at`             | Link           |
| -------- | ----------------- | ---------------------------------------------- | ---------------------------- | -------------- |
| Bookmark | `chrome:bookmark` | `chrome:bookmark:<guid>` (Default)             | `date_modified`/`date_added` | `metadata.url` |
| Bookmark | `chrome:bookmark` | `chrome:profile:<profile>:bookmark:<guid>`     | `date_modified`/`date_added` | `metadata.url` |
| History  | `chrome:history`  | `chrome:history:<sha1(url)>` (Default)         | `last_visit_time`            | `metadata.url` |
| History  | `chrome:history`  | `chrome:profile:<profile>:history:<sha1(url)>` | `last_visit_time`            | `metadata.url` |

Timestamps are converted from Chrome's WebKit epoch (microseconds since
1601-01-01) to RFC 3339. Every document includes its profile in
`metadata.profile` and in the searchable content. Non-`http(s)` URLs (e.g.
`chrome://`) get no link. The `Default` IDs remain compatible with the original
single-profile connector; other profiles receive a profile-qualified ID so
identical URLs or bookmark GUIDs cannot collide.

## Configuration

| Field                  | Type     | Default  | Notes                                                 |
| ---------------------- | -------- | -------- | ----------------------------------------------------- |
| `index_bookmarks`      | checkbox | `true`   | Index the Bookmarks file.                             |
| `index_history`        | checkbox | `true`   | Index the History database.                           |
| `profile_scope`        | dropdown | `all`    | Index `Default` only or all discovered profiles.      |
| `history_range`        | dropdown | required | `7d` · `30d` · `90d` · `365d` · `all` — how far back. |
| `history_skip_non_web` | checkbox | `true`   | Skip non-`http(s)` history URLs.                      |

The Chrome user-data directory is detected from the host OS — there is no path
setting. The connector scans `Default` and directories named `Profile N` when
`profile_scope` is `all`:

| OS      | User-data directory                           |
| ------- | --------------------------------------------- |
| Linux   | `~/.config/google-chrome`                     |
| macOS   | `~/Library/Application Support/Google/Chrome` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data`      |

For example, the Windows profiles are usually:

```text
%LOCALAPPDATA%\Google\Chrome\User Data\Default
%LOCALAPPDATA%\Google\Chrome\User Data\Profile 1
%LOCALAPPDATA%\Google\Chrome\User Data\Profile 2
```

Set `profile_scope` to `default` when the connector should only read the Default
profile.

`history_range` indexes only pages whose last visit falls within the window
(`all` removes the window). Pages never actually loaded are skipped.

## Sync behavior

- **Incremental history** via a per-profile `last_visit_time` high-water-mark
  cursor: each poll re-emits only pages visited since the last poll.
- **Bookmarks** are re-scanned in full each poll (small) and upserted
  idempotently.
- **Deletes stay in sync**: the connector remembers indexed ids in state and
  emits `del()` for bookmarks/history that disappear, fall out of scope, or
  belong to a profile that was removed.

Chrome keeps the live `History` DB locked and may hold recent writes in a WAL,
so each poll copies `History` (+ `-wal`/`-shm`) to a temp dir and reads the
copy.

## Build

```bash
deno task verify   # fmt + lint + type-check + test + build
deno task build    # just rebuild dist/main.js
```

`src/index.ts` is the source; `dist/main.js` is the committed entry Gety loads.
After editing source, rebuild and use **Restart** in Gety.

## Local runner

```bash
cp .env.example .env       # sets GETY_CONFIG_HISTORY_RANGE (required)
deno task runner -- --reset-state
deno task runner -- --polls 2
```

`history_range` is required, so set `GETY_CONFIG_HISTORY_RANGE` in `.env` (e.g.
`90d`). Output is written under `dev/runs/<timestamp>/` (summary, state
before/after, updates/deletes, and per-doc snapshots).

## Install in Gety

1. Open Gety's Custom Connectors settings.
2. Install from this local folder.
3. Choose `profile_scope` and `history_range` (and toggle bookmarks/history if
   desired).
4. Wait for the first poll, then search, e.g. `gety search <term>`.
