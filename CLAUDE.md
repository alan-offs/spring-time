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
```

## Hard constraints

- **Zero runtime dependencies, and it stays that way.** Everything is Node builtins
  (`node:sqlite`, `node:http`, `node:test`). There is no `node_modules`, no build
  step, no bundler, no transpile. `public/` is served as-authored. Node ≥ 22.5 is
  required for `node:sqlite`.
- ESM only (`"type": "module"`), no TypeScript.

## Architecture

`bin/wt.js` (CLI) → HTTP → `src/server.js` → `src/api.js` → `src/reports.js` / `src/db.js`.

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

**`public/`** — no framework: `app.js` renders DOM directly, the chart is hand-built
SVG. `sw.js` caches the app shell but always passes `/api/*` to the network so time
data is never stale-served; bump the `CACHE` constant when shell files change.

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
