# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`worktime` — a self-hosted work-time tracker: a `wt` CLI, a `node:http` server on
`127.0.0.1:4321`, a SQLite file at `~/.worktime/worktime.db`, and a vanilla-JS PWA
dashboard. See README.md for the user-facing CLI/API reference.

## Commands

```bash
npm test                                   # node:test, no fixtures or network
node --test test/reports.test.js           # one file
node --test --test-name-pattern 'slugify'  # one test / describe block
npm run dev                                # server with --watch
npm run icons                              # regenerate public/icon-*.png from icon.svg
node bin/wt.js <cmd>                       # run the CLI without npm link
bash scripts/build-menubar.sh              # macOS menu bar app (needs Xcode CLT)
```

## Hard constraints

- **Zero runtime dependencies, and it stays that way.** Everything is Node builtins
  (`node:sqlite`, `node:http`, `node:test`). There is no `node_modules`, no build
  step, no bundler, no transpile. `public/` is served as-authored. Node ≥ 22.5 is
  required for `node:sqlite`.
- ESM only (`"type": "module"`), no TypeScript.

## Architecture

`bin/wt.js` (CLI) → HTTP → `src/server.js` → `src/api.js` → `src/reports.js` /
`src/db.js` / `src/auth.js`.

The CLI is a **thin HTTP client**, not a second implementation. Timer and report
commands call `api()` against the local server and auto-boot it (`cmdUp`, a
detached `serve` child with a pidfile in `~/.worktime/`) if it isn't up. Any new
capability belongs in `src/api.js` as an endpoint; the CLI just renders it. Note
`bin/wt.js` keeps its own small date/format helpers so it never imports `src/`
except in `cmdServe` — keep that separation.

**`src/server.js`** — routing is a linear scan over the `routes` array exported by
`api.js` (`[method, regexp, handler]`). Handlers return a plain object that is
JSON-serialized, or a `{__raw: true, status, headers, body}` envelope for CSV.
Throwing `HttpError(status, msg)` is how you produce a non-500. Every non-`/api/`
path falls through to `public/index.html`: the client reads the project slug off
`location.pathname`, so `/p/<anything>` works with no server route.

**`src/db.js`** — schema is a single idempotent `CREATE TABLE IF NOT EXISTS` block
in `migrate()`; there is no migration framework, so schema changes must be
expressed additively. Two invariants live in the database rather than in code:
- `idx_entries_single_running`, a partial unique index on `ended_at IS NULL`,
  enforces one running timer globally — the CLI and dashboard can race safely.
- `ensureProject()` creates a project on first sight of a slug, which is what makes
  bare URLs work with no setup step. Never require an explicit create.

**`src/reports.js`** — aggregation happens in **JS, not SQL**, deliberately: local
timezone day boundaries and midnight splits are not expressible in the SQLite date
functions here. `loadEntries()` loads rows, clips each to the requested window
(treating a running entry as ending "now"), and everything else builds on it.
Three semantics that tests depend on and that are easy to break:
- entries are clipped to `[from, to]`, so a session starting before the window
  contributes only its overlap;
- `perDaySeconds()` splits a midnight-spanning session across both days when
  `groupBy=day`;
- a multi-tagged entry's seconds are divided evenly across its tags, so tag totals
  sum to the overall total instead of double counting.

**`src/auth.js`** — optional Google sign-in, and **identity only**: no route gates
data on it, and with `GOOGLE_OAUTH_*` unset `/api/auth/me` reports
`enabled: false` so the dashboard hides the button entirely. `WT_TOKEN` remains
the access control, and `/api/auth/*` is deliberately exempt from it — Google's
redirect back is a browser navigation that cannot carry a bearer header. Config
comes from a git-ignored repo-root `.env` via the builtin `process.loadEnvFile()`
(still zero dependencies); real environment variables win over the file. Sessions
are opaque random ids in a `sessions` table behind an HttpOnly `SameSite=Lax`
cookie — Lax and not Strict because the callback navigation has to be able to
read the CSRF state cookie. The `id_token` signature is not verified, because it
arrives on our own TLS connection to Google's token endpoint and no client-
submitted token is ever accepted.

**`src/teamwork.js` / `src/gmail.js`** — the "Log OT" feature (`/api/ot/*`). Same
shape as `sheets.js`: global `fetch`, a pure half the tests hit directly, and
Google calls that take an already-valid token. `teamwork.js` reads
`TEAMWORK_SITE` / `TEAMWORK_API_TOKEN` from `.env` at *call* time and shapes
timelogs into the Program tab of the OT template (one row per entry; the header
text is the template's verbatim). It queries a day either side and re-filters by
local day — a UTC-only window drops early-morning entries. `gmail.js` builds the
RFC 2822 message and creates a draft or sends; it maps a *scope-missing* 403 to 401
because a pre-Gmail session still refreshes a valid (scope-less) token, so the
failure surfaces at Gmail, not in `getGoogleAccessToken`. `/api/ot/send` always
re-fetches rows server-side (only the status column is client-overridable, and it is
multi-line) and appends the sender's own Gmail signature (read via `sendAs`, scope
`gmail.settings.basic` — the API never adds one; a missing scope fails the request
rather than mailing unsigned). Mail wording (`greeting`/`intro`/`closing`) is settings.
A module flag refuses a concurrent send so a mail can't go out twice. Recipients and
mode live in the additive `settings` table (`ot.*` keys). A task's board column is a
Teamwork *workflow stage*: the status column costs two extra reads (`tasks.json?ids=`
for `workflowStages` ids, then `workflows/{id}/stages.json` for names), is best-effort,
and falls back to blank (the dashboard lets the user type it).

**`public/`** — no framework: `app.js` renders DOM directly, the chart is hand-built
SVG. `sw.js` caches the app shell but always passes `/api/*` to the network so time
data is never stale-served; bump the `CACHE` constant when shell files change (and
add the file to `SHELL` if it's new).

**`public/md.js`** — an MD3 component layer that `app.js` imports, and the reason
"no framework" doesn't mean "native widgets". It **replaces** every browser/OS-rendered
control — `<select>`, `<datalist>`, `date`/`time` inputs, `confirm()`, `title=`
tooltips — with custom equivalents (`createSelect`, `attachAutocomplete`,
`attachDatePicker`, `attachTimePicker`, `choiceDialog`, `confirmDialog`,
`initTooltips`). Replacing a native control means re-implementing what the browser
gave away for free, so most of the file is roles, keyboard model and focus
handling rather than visuals — budget for that when touching it. Two rules it
encodes: `<dialog>` is the one native element deliberately kept (top-layer
stacking, backdrop, real focus trap), and popups are body-mounted `position:
fixed` so no ancestor's `overflow` can clip them — re-homed into an open
`<dialog>` when their anchor lives there. Build new UI on these, not on raw
native controls.

**`menubar/`** — an optional macOS status-bar app (`WorktimeMenuBar.swift`, built
by `scripts/build-menubar.sh` with bare `swiftc`, no Xcode project or SwiftPM
manifest). Like the CLI it is a **thin client over `/api/*`** — it polls
`GET /api/state` every 5s and ticks the digits locally in between — so new
capability still belongs in `src/api.js`, never in the Swift. It is the one part
of the repo that needs a toolchain (Xcode CLT); the Node side stays build-free.

## Color palette

The categorical palette is duplicated in `src/db.js` (`PALETTE`, assigned to new
projects round-robin) and `public/app.js` (`PALETTE` + `DARK_STEP` for the dark
surface). **The ordering is the colour-vision-deficiency safety mechanism**, not
cosmetics — validated at worst adjacent ΔE 9.1 light / 8.4 dark. Don't reorder,
insert, or recolour slots without re-validating, and keep the two copies in sync.

## Conventions

- Dates: `YYYY-MM-DD` local day keys at the API/CLI boundary; ISO-8601 UTC strings
  in the database. `dayKey`/`dayStart`/`addDays`/`weekStart` (Monday-based) in
  `reports.js` are the only correct converters — don't hand-roll new ones.
- Tags are a comma-joined string column, normalized through `normalizeTags()` on
  write and `splitTags()` on read.
- Tests exercise the report layer directly *and* over HTTP against a server bound
  to port 0 with a temp DB; `beforeEach` truncates both tables.
- `WT_PORT` / `WT_DB` / `WT_TOKEN` come from the environment, overridden by
  `~/.worktime/config.json`. When `WT_TOKEN` is set the whole `/api/*` surface
  requires it; the server binds to loopback only.
