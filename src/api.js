import { handle, ensureProject, slugify, HttpError } from './db.js';
import {
  loadEntries, summarize, timeseries, toCSV, splitTags,
  dayKey, addDays, weekStart,
} from './reports.js';
import {
  authEnabled, beginAuth, completeAuth, endSession, sessionUser, getGoogleAccessToken,
} from './auth.js';
import {
  parseSheetId, monthMatches, matchRows, todayTab, getMeta, getRows, updateRow, a1,
} from './sheets.js';
import { updateInfo, applyUpdate } from './update.js';

const nowISO = () => new Date().toISOString();

function runningEntry() {
  return handle()
    .prepare(
      `SELECT e.*, p.slug AS project_slug, p.name AS project_name, p.color AS project_color
         FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.ended_at IS NULL`
    )
    .get();
}

function stopRunning(at = nowISO()) {
  const running = runningEntry();
  if (!running) return null;
  // Guard against a clock skew / manual edit producing a negative duration.
  const end = new Date(at) < new Date(running.started_at) ? running.started_at : at;
  handle().prepare('UPDATE entries SET ended_at = ? WHERE id = ?').run(end, running.id);
  return { ...running, ended_at: end };
}

function shapeEntry(r) {
  return {
    id: r.id,
    project: r.project_slug,
    projectName: r.project_name,
    color: r.project_color,
    description: r.description,
    tags: splitTags(r.tags),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    running: !r.ended_at,
    status: r.status || '',
    percent: r.percent ?? null,
    eta: r.eta ?? null,
  };
}

/** Default window: last 7 days, ending today. */
function windowFrom(q) {
  const to = q.get('to') || dayKey(new Date());
  const from = q.get('from') || addDays(to, -6);
  const project = q.get('project');
  return { from, to, project: project ? slugify(project) : null, tag: q.get('tag') || null };
}

export const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, time: nowISO() })],

  ['GET', /^\/api\/update$/, () => updateInfo()],
  ['POST', /^\/api\/update$/, () => {
    applyUpdate();
    return { restarting: true };
  }],

  // ---- auth ---------------------------------------------------------------
  // Sign-in is identity only — no endpoint below gates any time data on it.
  ['GET', /^\/api\/auth\/me$/, (_m, { req }) => ({
    enabled: authEnabled(),
    user: authEnabled() ? sessionUser(req) : null,
  })],

  ['GET', /^\/api\/auth\/google$/, (_m, { query }) => {
    const { url, cookie } = beginAuth(query.get('next'));
    return redirect(url, [cookie]);
  }],

  ['GET', /^\/api\/auth\/google\/callback$/, async (_m, { req, query }) => {
    // The caller is a browser mid-navigation, not fetch(), so a failure has to
    // land back in the app with a message rather than as a JSON error page.
    try {
      const { next, cookies } = await completeAuth(req, query);
      return redirect(next, cookies);
    } catch (err) {
      return redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
    }
  }],

  ['POST', /^\/api\/auth\/logout$/, (_m, { req }) => ({
    __raw: true,
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': [endSession(req)],
    },
    body: JSON.stringify({ ok: true }),
  })],

  // ---- wip ----------------------------------------------------------------
  // Report the signed-in user's day into their row of the team's monthly WIP
  // Google Sheet. Every handler needs the user's Google token (Sheets scope);
  // getGoogleAccessToken throws 401 when the session can't provide one.
  //
  // The sheet columns are A Team, B Name, C "will work on today",
  // D "have done today", E "time more needed", F "need help".

  ['GET', /^\/api\/wip\/title$/, async (_m, { req, query }) => {
    const id = parseSheetId(query.get('id'));
    if (!id) throw new HttpError(400, 'missing or malformed sheet id');
    const token = await getGoogleAccessToken(req);
    const { title } = await getMeta(token, id);
    const { ok, month } = monthMatches(title, new Date());
    return { title, monthOk: ok, month };
  }],

  ['GET', /^\/api\/wip\/row$/, async (_m, { req, query }) => {
    const id = parseSheetId(query.get('id'));
    if (!id) throw new HttpError(400, 'missing or malformed sheet id');
    const user = sessionUser(req);
    if (!user) throw new HttpError(401, 'sign in with Google first');
    const token = await getGoogleAccessToken(req);

    const meta = await getMeta(token, id);
    const { ok, month } = monthMatches(meta.title, new Date());
    const tab = todayTab(meta.tabs, new Date());
    // Don't read rows from the wrong month's file — the client shows the warning
    // and stops.
    const candidates = ok && tab ? matchRows(await getRows(token, id, tab), user.name) : [];
    return { title: meta.title, monthOk: ok, month, tab, candidates };
  }],

  ['POST', /^\/api\/wip\/report$/, async (_m, { req, body }) => {
    const id = parseSheetId(body.id);
    if (!id) throw new HttpError(400, 'missing or malformed sheet id');
    const tab = String(body.tab || '').trim();
    if (!tab) throw new HttpError(400, 'missing tab');
    const rowNumber = Number(body.rowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 1) throw new HttpError(400, 'invalid row');

    const token = await getGoogleAccessToken(req);
    // Re-check the month server-side: the client already warned, but never trust
    // it to have stopped — this is the guard that actually prevents a wrong-month
    // write.
    const meta = await getMeta(token, id);
    const { ok, month } = monthMatches(meta.title, new Date());
    if (!ok) throw new HttpError(409, `that sheet is not ${month} — nothing was written`);

    // The daily-report preview goes into column D only ("What I have done for
    // today" / END OF DAY); nothing else in the row is touched.
    await updateRow(token, id, a1(tab, ['D', 'D'], rowNumber), [String(body.content ?? '')]);
    return { ok: true };
  }],

  // ---- projects -----------------------------------------------------------
  ['GET', /^\/api\/projects$/, () => {
    const rows = handle().prepare('SELECT * FROM projects ORDER BY archived, name').all();
    const totals = summarize({ groupBy: 'project' });
    const byKey = new Map(totals.items.map((i) => [i.key, i.seconds]));
    return rows.map((p) => ({
      slug: p.slug, name: p.name, color: p.color,
      archived: !!p.archived, totalSeconds: byKey.get(p.slug) || 0,
    }));
  }],

  ['POST', /^\/api\/projects$/, (_m, { body }) => {
    if (!body.slug && !body.name) throw new HttpError(400, 'slug or name required');
    return ensureProject(body.slug || body.name, body.name);
  }],

  ['PATCH', /^\/api\/projects\/([^/]+)$/, (m, { body }) => {
    const p = handle().prepare('SELECT * FROM projects WHERE slug = ?').get(slugify(decodeParam(m[1])));
    if (!p) throw new HttpError(404, 'project not found');
    handle().prepare('UPDATE projects SET name = ?, color = ?, archived = ? WHERE id = ?').run(
      body.name ?? p.name,
      body.color ?? p.color,
      body.archived === undefined ? p.archived : body.archived ? 1 : 0,
      p.id
    );
    return handle().prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
  }],

  ['DELETE', /^\/api\/projects\/([^/]+)$/, (m, { query }) => {
    const slug = slugify(decodeParam(m[1]));
    const p = handle().prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
    if (!p) throw new HttpError(404, 'project not found');

    const { n } = handle().prepare('SELECT COUNT(*) AS n FROM entries WHERE project_id = ?').get(p.id);
    // Deleting cascades to entries, so tracked time needs an explicit ?force=1.
    if (n && query.get('force') !== '1') {
      throw new HttpError(409, `project has ${n} entries; pass ?force=1 to delete them too`);
    }
    handle().prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    return { deleted: slug, entriesDeleted: n };
  }],

  // ---- timer --------------------------------------------------------------
  ['GET', /^\/api\/state$/, (_m, { query }) => {
    const r = runningEntry();
    const today = dayKey(new Date());
    // Scope the totals when the caller is looking at a single project, so the
    // tiles agree with the charts beside them.
    const scope = query.get('project') ? slugify(query.get('project')) : null;
    const statuses = handle()
      .prepare("SELECT DISTINCT status FROM entries WHERE status <> '' ORDER BY status")
      .all()
      .map((row) => row.status);
    return {
      running: r ? shapeEntry(r) : null,
      scope,
      statuses,
      todaySeconds: summarize({ from: today, to: today, project: scope }).totalSeconds,
      weekSeconds: summarize({ from: weekStart(today), to: today, project: scope }).totalSeconds,
    };
  }],

  ['POST', /^\/api\/projects\/([^/]+)\/start$/, (m, { body }) => {
    const project = ensureProject(decodeParam(m[1]), body.projectName);
    const stopped = stopRunning();
    handle()
      .prepare('INSERT INTO entries (project_id, description, tags, started_at) VALUES (?, ?, ?, ?)')
      .run(project.id, body.description || '', normalizeTags(body.tags), body.startedAt || nowISO());
    return { started: shapeEntry(runningEntry()), stopped: stopped ? shapeEntry(stopped) : null };
  }],

  ['POST', /^\/api\/stop$/, (_m, { body }) => {
    const stopped = stopRunning(body.endedAt || nowISO());
    if (!stopped) throw new HttpError(409, 'no timer is running');
    return shapeEntry(stopped);
  }],

  // ---- entries ------------------------------------------------------------
  // Reopen an entry instead of opening a sibling next to it, so a short break
  // does not fragment one session into a dozen near-identical rows. The break
  // itself is ambiguous — worked-through or genuinely away — so the caller says
  // which: 'include' keeps started_at and bills the gap, 'exclude' shifts
  // started_at forward by the gap so the accumulated duration is preserved and
  // counting resumes from now.
  ['POST', /^\/api\/entries\/(\d+)\/continue$/, (m, { body }) => {
    const mode = body.mode || 'include';
    if (mode !== 'include' && mode !== 'exclude') {
      throw new HttpError(400, "mode must be 'include' or 'exclude'");
    }
    const e = handle().prepare('SELECT * FROM entries WHERE id = ?').get(Number(m[1]));
    if (!e) throw new HttpError(404, 'entry not found');
    if (!e.ended_at) throw new HttpError(409, 'entry is already running');

    // Must come first: clearing ended_at while another timer runs would violate
    // idx_entries_single_running and surface as a raw SQLite error, not a 409.
    const stopped = stopRunning();

    if (mode === 'exclude') {
      // Clamp negatives the way stopRunning does, so a skewed clock cannot
      // push started_at into the future.
      const banked = Math.max(0, new Date(e.ended_at) - new Date(e.started_at));
      const started = new Date(Date.now() - banked).toISOString();
      handle().prepare('UPDATE entries SET started_at = ?, ended_at = NULL WHERE id = ?')
        .run(started, e.id);
    } else {
      handle().prepare('UPDATE entries SET ended_at = NULL WHERE id = ?').run(e.id);
    }
    return { continued: getEntry(e.id), stopped: stopped ? shapeEntry(stopped) : null };
  }],

  ['GET', /^\/api\/entries$/, (_m, { query }) => {
    const w = windowFrom(query);
    const limit = Math.min(Number(query.get('limit')) || 200, 1000);
    return loadEntries(w).slice(0, limit).map((e) => ({
      id: e.id, project: e.project, projectName: e.projectName, color: e.color,
      description: e.description, tags: e.tags, startedAt: e.startedAt,
      endedAt: e.endedAt, running: e.running, seconds: e.seconds,
      status: e.status, percent: e.percent, eta: e.eta,
    }));
  }],

  ['POST', /^\/api\/entries$/, (_m, { body }) => {
    if (!body.project) throw new HttpError(400, 'project required');
    if (!body.startedAt || !body.endedAt) throw new HttpError(400, 'startedAt and endedAt required');
    // Validate everything before ensureProject, so a rejected request never
    // leaves an empty project behind.
    const startedAt = parseTime(body.startedAt, 'startedAt');
    const endedAt = parseTime(body.endedAt, 'endedAt');
    if (new Date(endedAt) <= new Date(startedAt)) {
      throw new HttpError(400, 'endedAt must be after startedAt');
    }

    const project = ensureProject(body.project, body.projectName);
    const { status, percent, eta } = normalizeStatus(body);
    const info = handle()
      .prepare(
        `INSERT INTO entries (project_id, description, tags, started_at, ended_at, status, percent, eta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(project.id, body.description || '', normalizeTags(body.tags), startedAt, endedAt,
           status, percent, eta);
    return getEntry(info.lastInsertRowid);
  }],

  ['PATCH', /^\/api\/entries\/(\d+)$/, (m, { body }) => {
    const e = handle().prepare('SELECT * FROM entries WHERE id = ?').get(Number(m[1]));
    if (!e) throw new HttpError(404, 'entry not found');
    const projectId = body.project ? ensureProject(body.project).id : e.project_id;
    const started = body.startedAt ? parseTime(body.startedAt, 'startedAt') : e.started_at;
    const ended = body.endedAt === null
      ? null
      : body.endedAt ? parseTime(body.endedAt, 'endedAt') : e.ended_at;
    if (ended && new Date(ended) <= new Date(started)) {
      throw new HttpError(400, 'endedAt must be after startedAt');
    }
    // A running timer counts up to now, so a future start would render negative.
    if (!ended && new Date(started) > new Date()) {
      throw new HttpError(400, 'startedAt cannot be in the future while the timer is running');
    }
    // Re-normalize whenever any of status/percent/eta is supplied, so the
    // WIP-gating stays consistent (e.g. switching to Done clears percent/eta);
    // otherwise keep what's stored.
    const touchesStatus = 'status' in body || 'percent' in body || 'eta' in body;
    const { status, percent, eta } = touchesStatus
      ? normalizeStatus({
          status: 'status' in body ? body.status : e.status,
          percent: 'percent' in body ? body.percent : e.percent,
          eta: 'eta' in body ? body.eta : e.eta,
        })
      : { status: e.status, percent: e.percent, eta: e.eta };
    handle()
      .prepare(
        `UPDATE entries SET project_id = ?, description = ?, tags = ?, started_at = ?, ended_at = ?,
                            status = ?, percent = ?, eta = ?
          WHERE id = ?`
      )
      .run(projectId, body.description ?? e.description,
           body.tags === undefined ? e.tags : normalizeTags(body.tags), started, ended,
           status, percent, eta, e.id);
    return getEntry(e.id);
  }],

  ['DELETE', /^\/api\/entries\/(\d+)$/, (m) => {
    const info = handle().prepare('DELETE FROM entries WHERE id = ?').run(Number(m[1]));
    if (!info.changes) throw new HttpError(404, 'entry not found');
    return { deleted: Number(m[1]) };
  }],

  // ---- reports ------------------------------------------------------------
  ['GET', /^\/api\/reports\/summary$/, (_m, { query }) =>
    summarize({ ...windowFrom(query), groupBy: query.get('groupBy') || 'project' })],

  ['GET', /^\/api\/reports\/timeseries$/, (_m, { query }) => {
    const w = windowFrom(query);
    return { ...w, series: timeseries(w) };
  }],

  ['GET', /^\/api\/reports\/summary\.csv$/, (_m, { query }) => {
    const r = summarize({ ...windowFrom(query), groupBy: query.get('groupBy') || 'project' });
    return csv(
      toCSV(r.items, [
        { header: r.groupBy, value: (i) => i.key },
        { header: 'label', value: (i) => i.label ?? i.key },
        { header: 'seconds', value: (i) => i.seconds },
        { header: 'hours', value: (i) => (i.seconds / 3600).toFixed(2) },
        { header: 'entries', value: (i) => i.entries },
      ]),
      `summary-${r.from}_${r.to}.csv`
    );
  }],

  ['GET', /^\/api\/reports\/entries\.csv$/, (_m, { query }) => {
    const rows = loadEntries(windowFrom(query));
    return csv(
      toCSV(rows, [
        { header: 'project', value: (e) => e.project },
        { header: 'description', value: (e) => e.description },
        { header: 'tags', value: (e) => e.tags.join(' ') },
        { header: 'started_at', value: (e) => e.startedAt },
        { header: 'ended_at', value: (e) => e.endedAt ?? '' },
        { header: 'hours', value: (e) => (e.seconds / 3600).toFixed(2) },
      ]),
      'entries.csv'
    );
  }],
];

/** Reject unparseable timestamps as 400s rather than letting them throw a 500. */
function parseTime(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} is not a valid date`);
  return d.toISOString();
}

/** Path params arrive percent-encoded; "Acme API" must not slug to "acme-20api". */
function decodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean).join(',');
  return splitTags(tags).join(',');
}

/**
 * percent/eta only mean anything while a task is in progress, so anything but a
 * 'WIP' status stores them as NULL. percent is clamped to an integer 0-100.
 */
function normalizeStatus(body) {
  const status = String(body.status ?? '').trim();
  if (status !== 'WIP') return { status, percent: null, eta: null };
  const raw = body.percent;
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  const percent = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  const rawEta = body.eta == null ? '' : String(body.eta).trim();
  return { status, percent, eta: rawEta || null };
}

function getEntry(id) {
  return shapeEntry(
    handle()
      .prepare(
        `SELECT e.*, p.slug AS project_slug, p.name AS project_name, p.color AS project_color
           FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.id = ?`
      )
      .get(Number(id))
  );
}

function redirect(location, cookies = []) {
  return {
    __raw: true,
    status: 302,
    headers: { location, ...(cookies.length ? { 'set-cookie': cookies } : {}) },
    body: '',
  };
}

function csv(text, filename) {
  return {
    __raw: true,
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
    body: text,
  };
}

export { slugify };
