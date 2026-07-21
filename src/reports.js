import { handle } from './db.js';

/** Local-date key (YYYY-MM-DD) for a Date, in the server's timezone. */
export function dayKey(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Start of a local day, given YYYY-MM-DD. */
export function dayStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function dayEnd(key) {
  const s = dayStart(key);
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1, 0, 0, 0, 0);
}

export function addDays(key, n) {
  const s = dayStart(key);
  return dayKey(new Date(s.getFullYear(), s.getMonth(), s.getDate() + n));
}

/** Monday-based start of the week containing `key`. */
export function weekStart(key) {
  const s = dayStart(key);
  const shift = (s.getDay() + 6) % 7;
  return addDays(key, -shift);
}

/**
 * Fetch entries overlapping [from, to] (inclusive local day keys) and clip each
 * one to that window, so a session spanning midnight is split correctly across
 * days. A running entry is clipped to "now".
 */
export function loadEntries({ from, to, project, tag } = {}) {
  const now = new Date();
  const lo = from ? dayStart(from) : new Date(0);
  const hi = to ? dayEnd(to) : new Date(now.getTime() + 86400000);

  const rows = handle()
    .prepare(
      `SELECT e.*, p.slug AS project_slug, p.name AS project_name, p.color AS project_color
         FROM entries e JOIN projects p ON p.id = e.project_id
        ORDER BY e.started_at DESC`
    )
    .all();

  const out = [];
  for (const r of rows) {
    if (project && r.project_slug !== project) continue;
    if (tag && !splitTags(r.tags).includes(tag)) continue;

    const start = new Date(r.started_at);
    const end = r.ended_at ? new Date(r.ended_at) : now;
    if (end <= lo || start >= hi) continue;

    const clippedStart = start < lo ? lo : start;
    const clippedEnd = end > hi ? hi : end;
    out.push({
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
      seconds: Math.max(0, Math.round((clippedEnd - clippedStart) / 1000)),
      clippedStart,
      clippedEnd,
    });
  }
  return out;
}

export function splitTags(tags) {
  return String(tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Split one entry's duration across the local days it touches. */
function perDaySeconds(entry) {
  const spans = [];
  let cursor = new Date(entry.clippedStart);
  while (cursor < entry.clippedEnd) {
    const key = dayKey(cursor);
    const boundary = dayEnd(key);
    const chunkEnd = boundary < entry.clippedEnd ? boundary : entry.clippedEnd;
    spans.push({ day: key, seconds: Math.round((chunkEnd - cursor) / 1000) });
    cursor = chunkEnd;
  }
  return spans;
}

export function summarize({ from, to, project, tag, groupBy = 'project' } = {}) {
  const entries = loadEntries({ from, to, project, tag });
  const buckets = new Map();

  const bump = (key, seconds, meta) => {
    if (!buckets.has(key)) buckets.set(key, { key, seconds: 0, entries: 0, ...meta });
    const b = buckets.get(key);
    b.seconds += seconds;
    b.entries += 1;
  };

  for (const e of entries) {
    if (groupBy === 'day') {
      for (const s of perDaySeconds(e)) bump(s.day, s.seconds, { label: s.day });
    } else if (groupBy === 'tag') {
      const tags = e.tags.length ? e.tags : ['(untagged)'];
      // Split evenly so a multi-tagged entry isn't double counted in the total.
      const share = Math.round(e.seconds / tags.length);
      for (const t of tags) bump(t, share, { label: t });
    } else {
      bump(e.project, e.seconds, { label: e.projectName, color: e.color });
    }
  }

  const items = [...buckets.values()].sort((a, b) =>
    groupBy === 'day' ? a.key.localeCompare(b.key) : b.seconds - a.seconds
  );

  return {
    from: from || null,
    to: to || null,
    groupBy,
    totalSeconds: entries.reduce((n, e) => n + e.seconds, 0),
    entryCount: entries.length,
    items,
  };
}

/** Dense daily series (zero-filled) — what the dashboard chart consumes. */
export function timeseries({ from, to, project, tag }) {
  const byDay = new Map(
    summarize({ from, to, project, tag, groupBy: 'day' }).items.map((i) => [i.key, i.seconds])
  );
  const out = [];
  for (let k = from; k <= to; k = addDays(k, 1)) {
    out.push({ day: k, seconds: byDay.get(k) || 0 });
    if (out.length > 800) break;
  }
  return out;
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function toCSV(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.value(r))).join(','));
  return [head, ...body].join('\n') + '\n';
}
