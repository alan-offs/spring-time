#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = join(homedir(), '.worktime');
const CONFIG_FILE = join(HOME, 'config.json');
const LOG_FILE = join(HOME, 'server.log');
const ROOT = fileURLToPath(new URL('../', import.meta.url));

mkdirSync(HOME, { recursive: true });

const config = {
  port: Number(process.env.WT_PORT) || 4321,
  dbFile: process.env.WT_DB || join(HOME, 'worktime.db'),
  token: process.env.WT_TOKEN || '',
  ...(existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}),
};
const BASE = `http://127.0.0.1:${config.port}`;
// Scoped by port: a second instance on another port must not clobber the first
// one's pid file and orphan its process.
const PID_FILE = join(HOME, `server-${config.port}.pid`);

const [cmd = 'help', ...args] = process.argv.slice(2);
const flags = parseFlags(args);

const commands = {
  serve: cmdServe,
  up: cmdUp,
  down: cmdDown,
  update: cmdUpdate,
  start: cmdStartTimer,
  stop: cmdStopTimer,
  status: cmdStatus,
  today: () => cmdReport({ days: 1 }),
  week: () => cmdReport({ week: true }),
  report: () => cmdReport({}),
  open: cmdOpen,
  install: cmdInstall,
  uninstall: cmdUninstall,
  help: cmdHelp,
};

const run = commands[cmd] || (() => {
  console.error(`unknown command: ${cmd}\n`);
  cmdHelp();
  process.exit(1);
});

run().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});

// ---------------------------------------------------------------- server ----

async function cmdServe() {
  // Auto-pull on boot: pick up new commits before the server code is loaded, so
  // this same start runs the fresh src/ and public/. Best-effort — never let an
  // offline machine or a dirty tree block startup (launchd relaunches us on exit).
  await execP('git', ['-C', ROOT, 'pull', '--ff-only', '--quiet'])
    .then(() => console.log('✓ pulled latest'))
    .catch(() => {});

  const { createServer } = await import(join(ROOT, 'src/server.js'));
  const server = createServer({ dbFile: config.dbFile, token: config.token });
  await new Promise((resolve) => server.listen(config.port, '127.0.0.1', resolve));
  console.log(`worktime listening on ${BASE}  (db: ${config.dbFile})`);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

async function cmdUp() {
  if (await isUp()) return console.log(`already running at ${BASE}`);

  const out = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  if (await waitUntilUp()) console.log(`✓ worktime started at ${BASE}`);
  else throw new Error(`server failed to start — see ${LOG_FILE}`);
}

async function cmdDown() {
  const pid = existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8')) : await pidOnPort();
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);

  if (!pid) return console.log('not running');
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return console.log('not running (stale pid file)');
  }
  // Confirm it actually let go of the port rather than assuming SIGTERM took.
  for (let i = 0; i < 30; i++) {
    if (!(await isUp())) return console.log(`✓ stopped (pid ${pid})`);
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`! pid ${pid} did not exit; still listening on ${BASE}`);
}

// Pull the latest version and restart the running server onto it. Invoked from
// the terminal (`wt update`) and, detached, by the dashboard's Update button
// (src/update.js applyUpdate). Fast-forward only — never rewrites local work.
async function cmdUpdate() {
  let out;
  try {
    out = await execP('git', ['-C', ROOT, 'pull', '--ff-only']);
  } catch (err) {
    throw new Error(
      `git pull failed — resolve manually in ${ROOT}\n  ${(err.stderr || err.message).trim()}`
    );
  }
  if (/Already up to date/i.test(out)) return console.log('✓ already up to date');

  await cmdDown();
  await cmdUp();
  const sha = await execP('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).catch(() => '');
  console.log(`✓ updated${sha ? ` to ${sha.trim()}` : ''}`);
}

/** Recover the listening pid when the pid file is missing or was clobbered. */
async function pidOnPort() {
  if (!(await isUp())) return null;
  try {
    const out = await execP('lsof', ['-ti', `tcp:${config.port}`, '-sTCP:LISTEN']);
    return Number(out.trim().split('\n')[0]) || null;
  } catch {
    return null;
  }
}

async function isUp() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(700) });
    return r.ok || r.status === 401;
  } catch {
    return false;
  }
}

async function waitUntilUp(tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Every timer/report command transparently boots the server if it is down. */
async function api(path, options = {}) {
  if (!(await isUp())) await cmdUp();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// ----------------------------------------------------------------- timer ----

async function cmdStartTimer() {
  const project = flags._[0];
  // Bare `wt start` is the everyday case: bring the app up and hand it to the
  // browser, where the project and note get typed in.
  if (!project) return cmdOpen();

  const r = await api(`/api/projects/${encodeURIComponent(project)}/start`, {
    method: 'POST',
    body: { description: flags.m || flags.message || '', tags: flags.t || flags.tag || '' },
  });
  if (r.stopped) console.log(`⏸ stopped ${r.stopped.project} (${r.stopped.description || 'no note'})`);
  console.log(`▶ tracking ${r.started.projectName}${r.started.description ? ` — ${r.started.description}` : ''}`);
  console.log(`  ${BASE}/p/${r.started.project}`);
}

async function cmdStopTimer() {
  const r = await api('/api/stop', { method: 'POST', body: {} });
  const secs = Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000);
  console.log(`⏹ stopped ${r.projectName} after ${fmt(secs)}`);
}

async function cmdStatus() {
  const s = await api('/api/state');
  if (s.running) {
    const secs = Math.round((Date.now() - new Date(s.running.startedAt)) / 1000);
    console.log(`▶ ${s.running.projectName} — ${fmt(secs)}${s.running.description ? ` (${s.running.description})` : ''}`);
  } else {
    console.log('⏹ no timer running');
  }
  console.log(`  today ${fmt(s.todaySeconds)} · this week ${fmt(s.weekSeconds)}`);
}

// --------------------------------------------------------------- reports ----

async function cmdReport({ days, week }) {
  const today = localDay(new Date());
  let from = flags.from;
  let to = flags.to || today;
  if (!from) {
    if (days === 1) from = today;
    else if (week) from = mondayOf(today);
    else from = shiftDay(to, -(Number(flags.days) || 7) + 1);
  }

  const group = flags.group || flags.g || 'project';
  const qs = new URLSearchParams({ from, to, groupBy: group });
  if (flags.project) qs.set('project', flags.project);

  const r = await api(`/api/reports/summary?${qs}`);
  const heading = from === to ? fmtDay(from) : `${fmtDay(from)} → ${fmtDay(to)}`;
  console.log(`\n  ${heading}   total ${fmt(r.totalSeconds)}  (${r.entryCount} entries)\n`);

  if (!r.items.length || !r.totalSeconds) return console.log('  no time tracked\n');
  const width = Math.max(...r.items.map((i) => (i.label || i.key).length));
  const max = Math.max(...r.items.map((i) => i.seconds));
  for (const i of r.items) {
    const label = (group === 'day' ? fmtDay(i.key) : (i.label || i.key)).padEnd(width);
    const bar = '█'.repeat(max ? Math.max(1, Math.round((i.seconds / max) * 24)) : 0);
    const pct = ((i.seconds / r.totalSeconds) * 100).toFixed(0).padStart(3);
    console.log(`  ${label}  ${fmt(i.seconds).padStart(7)}  ${pct}%  ${bar}`);
  }
  console.log('');
}

// Chrome installs a PWA as `~/Applications/Chrome Apps.localized/<manifest name>.app`.
const CHROME_APP = join(homedir(), 'Applications/Chrome Apps.localized/worktime.app');

/** The installed standalone app, or null when only a browser is available. */
function installedApp() {
  return process.platform === 'darwin' && existsSync(CHROME_APP) ? CHROME_APP : null;
}

async function cmdOpen() {
  if (!(await isUp())) await cmdUp();
  const project = flags._[0];
  const url = project ? `${BASE}/p/${encodeURIComponent(project)}` : BASE;

  // Chrome's app launcher always lands on the manifest start_url and drops any
  // URL argument, so the installed app can only serve the dashboard, not a
  // project deep link. `open -a` reuses the existing window instead of stacking.
  const app = !project && installedApp();
  if (app) {
    execFile('open', ['-a', app], () => {});
    console.log(`▶ ${url}  (app)`);
    return;
  }

  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(opener, [url], () => {});
  console.log(`▶ ${url}`);
}

// --------------------------------------------------------------- install ----

const PLIST = join(homedir(), 'Library/LaunchAgents/com.worktime.server.plist');

async function cmdInstall() {
  writeFileSync(CONFIG_FILE, JSON.stringify({ port: config.port, dbFile: config.dbFile, token: config.token }, null, 2));

  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.worktime.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(ROOT, 'bin/wt.js')}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
`;
    mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(PLIST, plist);
    await execP('launchctl', ['unload', PLIST]).catch(() => {});
    await execP('launchctl', ['load', PLIST]);
    console.log(`✓ autostart installed (launchd: com.worktime.server)`);
  } else {
    console.log('! autostart is macOS-only for now; run `wt up` to start manually');
  }

  const line = `alias wt="node ${join(ROOT, 'bin/wt.js')}"`;
  console.log(`\nAdd this alias to your shell (~/.zshrc):\n\n  ${line}\n`);
  console.log(`Or link it globally:\n\n  npm link\n`);
  console.log(`Then: wt start myproject · wt status · wt today · wt open`);
}

async function cmdUninstall() {
  if (existsSync(PLIST)) {
    await execP('launchctl', ['unload', PLIST]).catch(() => {});
    unlinkSync(PLIST);
    console.log('✓ autostart removed');
  } else {
    console.log('autostart not installed');
  }
}

function execP(cmd, argv) {
  return new Promise((resolve, reject) =>
    execFile(cmd, argv, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  );
}

// ------------------------------------------------------------------ misc ----

function cmdHelp() {
  console.log(`
  worktime — track time per project, one URL each

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
    wt update                pull the latest version and restart
    wt install               autostart at login + alias instructions

  API      ${BASE}/api/reports/summary?from=&to=&groupBy=
  Data     ${config.dbFile}
`);
  return Promise.resolve();
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    } else if (a.startsWith('-') && a.length > 1) {
      out[a.slice(1)] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fmt(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ISO day key "YYYY-MM-DD" -> day-first display "DD/MM/YYYY".
const fmtDay = (key) => {
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
};

function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

function mondayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return shiftDay(key, -((date.getDay() + 6) % 7));
}
