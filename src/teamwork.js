// Teamwork API v3 client + the OT-request table, for the "Log OT" feature.
//
// Zero dependencies: like src/sheets.js this uses the global `fetch`. The pure
// bits (row shaping, formatting, HTML) are exported separately because they are
// what the tests exercise; the network bits only fetch and hand over.
//
// The table mirrors the "Program" tab of `OT Request Template.xlsx`: seven columns,
// one row per time entry, plus a total row (the old Apps Script's `onChange`).
import { HttpError } from './db.js';
import { dayKey, addDays } from './reports.js';

export const OT_HEADERS = [
  'Date (dd/mm/yyyy)',
  'Start time (HH:MM)',
  'End time (HH:MM)',
  'Duration (hours)',
  'Project name',
  'Link or title of tasks',
  "Task's status",
];

// ------------------------------------------------------------------ config --

/**
 * Teamwork site + personal API token from the environment (loaded from `.env` by
 * auth.js at import). Read at call time so tests and `.env` edits are honoured.
 */
export function teamworkConfig() {
  const site = String(process.env.TEAMWORK_SITE || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  const token = String(process.env.TEAMWORK_API_TOKEN || '').trim();
  if (!site || !token) {
    throw new HttpError(503, 'Teamwork is not configured — set TEAMWORK_SITE and TEAMWORK_API_TOKEN in .env');
  }
  return { site, token };
}

// --------------------------------------------------------------- pure bits --

const pad = (n) => String(n).padStart(2, '0');

/**
 * The template's date column as it appears in real OT mails and in the CSV export of
 * the Program tab: `dd/mm/yy` (12 Nov 2026 -> `12/11/26`). The header text says
 * dd/mm/yyyy and the xlsx cell format is mm/dd; the actual sent mail beats both.
 */
export function formatDate(date) {
  const d = new Date(date);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
}

/** Cell display of the template's time columns: `h:mm:ss AM/PM`, e.g. `10:00:00 PM`. */
export function formatTime(date) {
  const d = new Date(date);
  const h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Hours as the sheet shows them: at most two decimals, no trailing zeros (`2`, `0.42`). */
export function formatHours(minutes) {
  return String(Math.round((minutes / 60) * 100) / 100);
}

/**
 * `Xh Ym` from a *minute* count. The sheet's own formula rounds the fractional
 * hour, which can print `60m`; working from whole minutes cannot.
 */
export function formatTotal(minutes) {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

/** Items of an `included` block, whether Teamwork sent a map keyed by id or an array. */
function lookup(included, kind, id) {
  const bucket = included?.[kind];
  if (!bucket || id == null) return undefined;
  if (Array.isArray(bucket)) return bucket.find((x) => String(x.id) === String(id));
  return bucket[String(id)];
}

/**
 * The task's board column, which Teamwork models as a *workflow stage*. Verified
 * against a live site: a task from `tasks.json` carries only ids —
 * `workflowStages: [{ workflowId, stageId }]` — and the names live in
 * `workflows/{workflowId}/stages.json`, which fetchOtRows merges into
 * `included.stages`. A task on several boards yields every name, comma-joined; a
 * task on none (or whose stage names couldn't be fetched) yields '' and the
 * dashboard lets the user type the status in.
 */
export function boardColumnName(task, included) {
  const names = (task?.workflowStages || [])
    .map((s) => lookup(included, 'stages', s.stageId)?.name)
    .filter(Boolean);
  return [...new Set(names)].join(', ');
}

/**
 * Turn Teamwork timelogs into template rows for one local day. Teamwork's date
 * filters are not guaranteed to share our local day boundaries, so the caller
 * fetches a day either side and this keeps only entries that *start* on `day`
 * locally (the 7:27 AM entry in UTC+7 belongs to the previous UTC date).
 *
 * One row per timelog. `hasStartTime` false means Teamwork only knows the day, so
 * Start/End are left blank rather than inventing 12:00:00 AM.
 *
 * When `userId` is given, only that person's timelogs survive. The query's
 * `assignedToUserIds` is not trusted to do this alone — its documented semantics are
 * vague, and a teammate's hours must never end up in a mail sent in someone else's name.
 */
export function toOtRows(timelogs, included, site, day, userId) {
  const rows = [];
  for (const t of timelogs || []) {
    if (userId != null && String(t.userId) !== String(userId)) continue;
    const logged = new Date(t.timeLogged);
    if (Number.isNaN(logged.getTime())) continue;
    if (dayKey(logged) !== day) continue;

    const minutes = Number(t.minutes) || 0;
    const timed = t.hasStartTime !== false;
    const end = new Date(logged.getTime() + minutes * 60_000);

    const task = lookup(included, 'tasks', t.taskId);
    const project = lookup(included, 'projects', t.projectId);
    rows.push({
      id: t.id,
      sortKey: logged.getTime(),
      date: formatDate(logged),
      start: timed ? formatTime(logged) : '',
      end: timed ? formatTime(end) : '',
      minutes,
      hours: formatHours(minutes),
      project: project?.name || '',
      // The template's column F is the task URL; entries with no task fall back to
      // their own description so the row still says what the time was spent on.
      link: t.taskId ? `https://${site}/app/tasks/${t.taskId}` : String(t.description || '').trim(),
      // What the link is labelled with in the mail: the task's name, not its bare URL.
      title: String(task?.name || '').trim(),
      status: boardColumnName(task, included),
    });
  }
  rows.sort((a, b) => a.sortKey - b.sortKey || a.id - b.id);
  return rows;
}

export const totalMinutes = (rows) => rows.reduce((sum, r) => sum + r.minutes, 0);

const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Inline styles are mandatory — mail clients drop <style>. Look is the old
// Apps Script's `doGet`: black hairlines, green header, grey total row.
const TABLE = 'border-collapse:collapse;font-family:Arial, sans-serif;font-size:13px;table-layout:auto;';
const TH = 'background:#d9ead3;border:1px solid #000;padding:2px 4px;font-weight:bold;text-align:center;white-space:nowrap;color:#000;';
const TD = 'background:#fff;border:1px solid #000;padding:2px 4px;text-align:right;white-space:nowrap;color:#000;';
const TD_TOTAL = 'background:#f0f0f0;border:1px solid #000;padding:2px 4px;font-weight:bold;text-align:right;white-space:nowrap;color:#000;';

/**
 * Cell content: an https URL becomes a link labelled with `title` (falling back to
 * the URL itself); anything else is text, with line breaks kept — the status cell is
 * multi-line ("Done local" / "- #25-28: Done" / ...).
 */
function cellHtml(value, title = '') {
  const text = String(value ?? '');
  if (/^https:\/\/\S+$/.test(text)) {
    return `<a href="${escapeHtml(text)}" style="color:#1155cc;text-decoration:none;">${escapeHtml(title || text)}</a>`;
  }
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/** The full table, ready to be an email body. Every Teamwork-sourced value is escaped. */
export function renderOtHtml(rows) {
  const cells = (r) => [r.date, r.start, r.end, r.hours, r.project, r.link, r.status];
  const head = `<tr>${OT_HEADERS.map((h) => `<th style="${TH}">${escapeHtml(h)}</th>`).join('')}</tr>`;
  const body = rows
    .map((r) => `<tr>${cells(r).map((c, i) => `<td style="${TD}">${cellHtml(c, i === 5 ? r.title : '')}</td>`).join('')}</tr>`)
    .join('');
  // Total sits in column D only, the other six cells are blank — as in the sample.
  const total = `<tr>${OT_HEADERS.map(
    (_, i) => `<td style="${TD_TOTAL}">${i === 3 ? escapeHtml(formatTotal(totalMinutes(rows))) : ''}</td>`,
  ).join('')}</tr>`;
  return `<table style="${TABLE}">${head}${body}${total}</table>`;
}

/**
 * The whole mail body: greeting, intro line, the table, closing, then the sender's own
 * Gmail signature. Text parts are escaped (they come from settings); the signature is
 * the user's own HTML from Gmail and goes in as-is, wrapped the way Gmail marks one so
 * it is recognised as a signature rather than body text. Empty parts are skipped.
 */
export function renderOtEmail({ greeting, intro, rows, closing, signature }) {
  const para = (text) => {
    const t = String(text ?? '').trim();
    return t ? `<div>${escapeHtml(t).replace(/\r?\n/g, '<br>')}</div><br>` : '';
  };
  const sig = String(signature ?? '').trim();
  return [
    para(greeting),
    para(intro),
    renderOtHtml(rows),
    '<br>',
    para(closing),
    sig ? `<div class="gmail_signature" data-smartmail="gmail_signature">${sig}</div>` : '',
  ].join('');
}

/** Subject from the saved template; `{name}` is the user, `{date}` is YYYY-MM-DD. */
export function otSubject(template, name, day) {
  return String(template || 'OT request - {name} - {date}')
    .replaceAll('{name}', name || '')
    .replaceAll('{date}', day)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

// --------------------------------------------------------------- API calls --

async function call(cfg, path) {
  const res = await fetch(`https://${cfg.site}/projects/api/v3/${path}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.token}:x`).toString('base64')}`,
      accept: 'application/json',
    },
  });
  const payload = await res.json().catch(() => ({}));
  if (res.ok) return payload;

  const detail = payload?.MESSAGE || payload?.message || payload?.error || res.status;
  if (res.status === 401 || res.status === 403) {
    // Not our 401: that status tells the dashboard to re-run Google sign-in.
    throw new HttpError(502, `Teamwork rejected the API token: ${detail}`);
  }
  throw new HttpError(502, `Teamwork error: ${detail}`);
}

/**
 * Every timelog of the token's owner that starts on local day `day`. Asks for a day
 * either side (see toOtRows), then lets the caller's local-day filter decide.
 */
export async function fetchOtRows(day) {
  const cfg = teamworkConfig();
  const me = await call(cfg, 'me.json');
  const userId = me?.person?.id ?? me?.user?.id ?? me?.id;
  if (!userId) throw new HttpError(502, 'Teamwork did not say who the API token belongs to');

  const timelogs = [];
  const included = { tasks: {}, projects: {}, stages: {} };
  for (let page = 1; page <= 20; page++) {
    const qs = new URLSearchParams({
      startDate: addDays(day, -1),
      endDate: addDays(day, 1),
      assignedToUserIds: String(userId),
      include: 'tasks,projects',
      pageSize: '500',
      page: String(page),
    });
    const data = await call(cfg, `time.json?${qs}`);
    timelogs.push(...(data.timelogs || []));
    for (const [kind, bucket] of Object.entries(data.included || {})) {
      const merged = (included[kind] ??= {});
      if (Array.isArray(bucket)) bucket.forEach((x) => { merged[String(x.id)] = x; });
      else Object.assign(merged, bucket);
    }
    if (!data.meta?.page?.hasMore) break;
  }

  // Only tasks that will actually be mailed need their board column looked up.
  const taskIds = [...new Set(
    timelogs
      .filter((t) => String(t.userId) === String(userId) && dayKey(new Date(t.timeLogged)) === day)
      .map((t) => t.taskId)
      .filter(Boolean),
  )];
  await attachStages(cfg, included, taskIds);
  return toOtRows(timelogs, included, cfg.site, day, userId);
}

/**
 * Fill `included.tasks[id].workflowStages` and `included.stages` (stageId -> {name}).
 * The time endpoint's embedded tasks are trimmed and carry no stages, so this takes
 * two more reads: the full tasks (by id), then each workflow's stage list.
 *
 * Best-effort by design: the board column is a nicety, and the dashboard lets the
 * user type the status in, so a failure here leaves the column blank instead of
 * blocking an OT mail.
 */
async function attachStages(cfg, included, taskIds) {
  try {
    for (let i = 0; i < taskIds.length; i += 100) {
      const qs = new URLSearchParams({
        ids: taskIds.slice(i, i + 100).join(','),
        includeCompletedTasks: 'true', // a finished task is the usual thing to log time against
        pageSize: '500',
      });
      const { tasks = [] } = await call(cfg, `tasks.json?${qs}`);
      for (const t of tasks) included.tasks[String(t.id)] = { ...included.tasks[String(t.id)], ...t };
    }
    const workflowIds = new Set(
      Object.values(included.tasks).flatMap((t) => (t.workflowStages || []).map((s) => s.workflowId)),
    );
    for (const id of workflowIds) {
      const { stages = [] } = await call(cfg, `workflows/${id}/stages.json`);
      for (const s of stages) included.stages[String(s.id)] = s;
    }
  } catch {
    /* leave the status column blank — see above */
  }
}
