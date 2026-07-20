# worktime

A self-hosted work-time tracker. One URL per project, a reporting API, an
installable dashboard, and a CLI that starts the server for you.

**Zero dependencies** — Node 22.5+ only (`node:sqlite`, `node:http`). No install step.

```bash
wt start     # boots the server and opens the app — type the task there, hit Enter
wt stop      # stop the running timer
wt status
wt today
```

The browser is the input surface: `wt start` opens the app with the caret already
in the project box. Type a project, Tab, type what you're doing, press **Enter** —
tracking begins. The terminal form (`wt start <project> -m "note"`) is still there
when you'd rather not leave the shell.

### Fixing the clock

- **Forgot to hit start?** While a timer runs, a **since HH:MM** field sits next to
  the elapsed clock. Change it and the elapsed time updates immediately — the date
  is taken from the existing start, so only the time-of-day moves. A time later
  than now is read as "started last night" and rolls back a day rather than
  showing negative elapsed.
- **Worked without the timer at all?** **+ Add entry** opens a form for project,
  description, date, start, end and tags. An end time earlier than the start is
  treated as a session that ran past midnight.
- **Got something wrong?** Every finished row in the entries table has **Edit**,
  which reopens the same form.

## Install

```bash
cd internal_tools
npm link          # puts `wt` on your PATH
wt install        # autostart at login (launchd) + alias instructions
```

Prefer not to touch your global npm? Add an alias instead:

```bash
echo 'alias wt="node '"$PWD"'/bin/wt.js"' >> ~/.zshrc && source ~/.zshrc
```

Any timer or report command boots the server automatically if it isn't running,
so there is nothing to remember.

## One URL per project

The project slug lives in the URL, and **a project is created the first time you
visit or track against it** — no setup step:

| URL | What it shows |
|---|---|
| `http://localhost:4321/` | all projects |
| `http://localhost:4321/p/acme-api` | just `acme-api` — tiles, chart and entries all scoped |

Bookmark one URL per project, or open each in its own installed window.

## CLI

```
EVERYDAY
  wt start                                      open the app — type the task there
  wt stop                                       stop the running timer
  wt status                                     what am I tracking right now

FROM THE TERMINAL INSTEAD
  wt start <project> [-m "note"] [-t tag,tag]   start a timer without the browser

REPORTS
  wt today                                      today's breakdown
  wt week                                       this week (Mon–today)
  wt report [--days 30] [--from Y-M-D] [--to Y-M-D]
            [--group project|day|tag] [--project slug]

APP
  wt open [project]        open the dashboard (or a project page)
  wt up / wt down          start / stop the background server
  wt serve                 run the server in the foreground
  wt install / uninstall   autostart at login
```

`wt report` prints a bar breakdown in the terminal:

```
  2026-07-14 → 2026-07-20   total 36h 45m  (14 entries)

  Acme Api        18h 0m   49%  ████████████████████████
  Internal Tools   7h 30m  20%  ██████████
  Side Project     7h 0m   19%  █████████
  Client Zeta      4h 15m  12%  ██████
```

## API

Everything the dashboard does is a documented endpoint. Base `http://localhost:4321`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | liveness |
| `GET` | `/api/state` | running timer + today/week totals; `?project=` to scope |
| `GET` | `/api/projects` | all projects with lifetime totals |
| `POST` | `/api/projects` | `{slug, name}` — usually unnecessary, slugs auto-create |
| `PATCH` | `/api/projects/:slug` | `{name, color, archived}` |
| `DELETE` | `/api/projects/:slug` | refuses if it has entries; `?force=1` deletes them too |
| `POST` | `/api/projects/:slug/start` | `{description, tags}` — stops any running timer |
| `POST` | `/api/stop` | stop the running timer |
| `GET` | `/api/entries` | `?from&to&project&tag&limit` |
| `POST` | `/api/entries` | `{project, description, tags, startedAt, endedAt}` |
| `PATCH` | `/api/entries/:id` | edit any field |
| `DELETE` | `/api/entries/:id` | |
| `GET` | `/api/reports/summary` | `?from&to&project&tag&groupBy=project\|day\|tag` |
| `GET` | `/api/reports/timeseries` | zero-filled daily series |
| `GET` | `/api/reports/summary.csv` | CSV download |
| `GET` | `/api/reports/entries.csv` | CSV download |

`from`/`to` are inclusive local dates (`YYYY-MM-DD`) and default to the last 7 days.

```bash
curl 'localhost:4321/api/reports/summary?from=2026-07-01&to=2026-07-31&groupBy=day'
curl -o july.csv 'localhost:4321/api/reports/entries.csv?from=2026-07-01&to=2026-07-31'
```

### Reporting semantics

- **Entries are clipped to the window**, so a session that starts before `from`
  contributes only its overlap.
- **A session spanning midnight is split across both days** in `groupBy=day`.
- **A running timer counts up to now**, so today's totals are always live.
- **Multi-tagged time is divided evenly between its tags**, so tag totals sum to
  the overall total instead of double counting.

## Install as an app

The dashboard is a PWA. In Chrome, open it and use **Install** in the address bar
(or ⋮ → Cast, save & share → Install page as app) — it gets its own window, dock
icon and shortcuts, exactly like Google Chat. `localhost` counts as a secure
context, so the service worker and install prompt work without HTTPS.

Install `/p/acme-api` directly and that window opens straight into that project.

## macOS menu bar

A small companion app puts the running timer in the menu bar — `▶ 1:24:05 · F45`
while a timer runs, today's total when none does — and its dropdown can stop the
timer, start any project, and open the dashboard.

**Open dashboard** prefers the dashboard installed as an app (see above) and only
falls back to a browser tab when it isn't installed. It finds the installed app by
the start URL recorded in the bundle rather than by name — Chromium names the
bundle from the page title, so this one installs as `worktime.app` even though the
manifest says `SpringTime` — which also means an app installed against a different
port correctly doesn't match. To check what it would do:

```bash
menubar/build/Worktime.app/Contents/MacOS/Worktime --which-app
```

```bash
./scripts/build-menubar.sh          # → menubar/build/Worktime.app
open menubar/build/Worktime.app
```

It needs the Xcode command line tools for `swiftc` (`xcode-select --install`),
which is the only thing in this repo that does. Nothing else changes: the app is
another client of the same local API, so it, the CLI and the dashboard stay in
agreement — the running timer lives in SQLite, not in any one of them.

To keep it running, add the built app under **System Settings → General → Login
Items**. It reads `WT_PORT` / `WT_TOKEN` the same way the CLI does, config file
included.

## Configuration

Read from the environment, or persisted to `~/.worktime/config.json` by `wt install`.

| Variable | Default | Meaning |
|---|---|---|
| `WT_PORT` | `4321` | port |
| `WT_DB` | `~/.worktime/worktime.db` | SQLite file |
| `WT_TOKEN` | *(unset)* | if set, `/api/*` requires `Authorization: Bearer <token>` or `?token=` |

The server binds to `127.0.0.1` only. Set `WT_TOKEN` before exposing it beyond
your machine (e.g. through a tunnel), since the API is otherwise unauthenticated.

Data lives in one SQLite file — back it up by copying `~/.worktime/worktime.db`.

## Development

```bash
npm test        # 15 tests, no network or fixtures needed
npm run dev     # server with --watch
npm run icons   # regenerate PNG icons from the vector source
```

## Design notes

- **Chart colours** use a categorical palette validated for colour-vision
  deficiency (worst adjacent ΔE 9.1 light / 8.4 dark) with a separate set of
  steps selected for the dark surface. Bars are directly labelled and a legend is
  always present, so identity never rests on colour alone.
- **One timer at a time** is enforced by a partial unique index in SQLite, not by
  application logic, so it holds even if the CLI and dashboard race.
- Reports aggregate in JS rather than SQL so local-timezone day boundaries and
  midnight splits are correct.
