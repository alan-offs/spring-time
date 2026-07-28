// worktime — dashboard client.
// The project scope comes straight off the URL: /p/<slug> tracks one project,
// / is the all-projects view.

import {
  createSelect, attachAutocomplete, attachDatePicker, attachTimePicker,
  confirmDialog, choiceDialog, promptDialog, initTooltips,
} from './md.js';

// Statuses the dropdown always offers; user-added ones are merged in from the
// server (any distinct status already saved) plus any added this session.
const DEFAULT_STATUSES = ['WIP', 'Done', 'Done local', 'Ready For QA'];
const ADD_STATUS = '__add_status__';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Categorical slots in fixed order — assigned, never cycled. */
const PALETTE = [
  '#2a78d6', '#008300', '#e87ba4', '#eda100',
  '#1baf7a', '#eb6834', '#4a3aa7', '#e34948',
];

/** Light hex -> dark-mode step, for the categorical slots stored in the DB. */
const DARK_STEP = {
  '#2a78d6': '#3987e5', '#008300': '#008300', '#e87ba4': '#d55181',
  '#eda100': '#c98500', '#1baf7a': '#199e70', '#eb6834': '#d95926',
  '#4a3aa7': '#9085e9', '#e34948': '#e66767',
};

const state = {
  scope: scopeFromURL(),
  range: 'week',
  running: null,
  projects: [],
  user: null,
  tick: null,
};

function scopeFromURL() {
  const m = location.pathname.match(/^\/p\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function isDark() {
  const stamp = document.documentElement.dataset.theme;
  if (stamp) return stamp === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

const seriesColor = (hex) => (isDark() ? DARK_STEP[hex] || hex : hex);

/** Resolve an MD3 design token so canvas-free SVG fills can use the same roles. */
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ------------------------------------------------------------------ utils --

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n));
}

/** Monday-based start of the week containing `key` (mirrors reports.js). */
function weekStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  const shift = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return shiftDay(key, -shift);
}

/** First / last local day of the calendar month containing `key`. */
const monthStart = (key) => `${key.slice(0, 7)}-01`;
const monthEnd = (key) => {
  const [y, m] = key.split('-').map(Number);
  return dayKey(new Date(y, m, 0));
};

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (!h && !m) return seconds > 0 ? '<1m' : '0m';
  return h ? `${h}h ${m}m` : `${m}m`;
}

function fmtClock(seconds) {
  const h = Math.floor(seconds / 3600);
  return `${h}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** ISO -> "HH:MM" in local time, for <input type="time">. */
const timeValue = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * "YYYY-MM-DD" + "HH:MM" (local) -> ISO, or null when either half is missing or
 * malformed. Returning null rather than throwing matters: the pickers in md.js
 * can hand us a blank field, and `new Date(NaN).toISOString()` would abort the
 * submit handler mid-flight with a RangeError instead of showing an error.
 */
function localISO(day, time) {
  const [y, mo, d] = String(day ?? '').split('-').map(Number);
  const [h, mi] = String(time ?? '').split(':').map(Number);
  if ([y, mo, d, h, mi].some((n) => !Number.isFinite(n))) return null;
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function range() {
  const today = dayKey(new Date());
  if (state.range === 'today') return { from: today, to: today };
  if (state.range === 'month') return { from: monthStart(today), to: monthEnd(today) };
  const mon = weekStart(today);
  return { from: mon, to: shiftDay(mon, 6) };
}

function rangeQuery(extra = {}) {
  const q = new URLSearchParams({ ...range(), ...extra });
  if (state.scope) q.set('project', state.scope);
  return q;
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ------------------------------------------------------------------ chart --

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Bar with a 4px rounded data-end and a square baseline end. */
function barPath(x, y, w, h, r = 4, dir = 'up') {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (dir === 'up') {
    return `M${x},${y + h}V${y + rr}a${rr},${rr} 0 0 1 ${rr},${-rr}h${w - 2 * rr}a${rr},${rr} 0 0 1 ${rr},${rr}V${y + h}Z`;
  }
  return `M${x},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 ${-rr},${rr}H${x}Z`;
}

function niceTicks(max, count = 3) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= raw) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(v);
  return ticks;
}

/**
 * Timeline tick steps, in seconds. Each one divides an hour or is a whole number
 * of hours, so every tick lands on a clean HH:MM no matter where the day starts.
 */
const TIME_STEPS = [300, 600, 900, 1800, 3600, 7200, 10800, 21600];

/**
 * Seconds-from-midnight -> "HH:MM", wrapping 24:00 back to 00:00. Lives out here
 * because `renderGantt` shadows `pad` with its padding object.
 */
const tickTime = (sec) => `${pad(Math.floor(sec / 3600) % 24)}:${pad(Math.floor(sec / 60) % 60)}`;

function bindTip(node, tipEl, html) {
  const show = (e) => {
    const box = tipEl.parentElement.getBoundingClientRect();
    tipEl.innerHTML = html;
    tipEl.style.left = `${e.clientX - box.left}px`;
    tipEl.style.top = `${e.clientY - box.top - 10}px`;
    tipEl.style.opacity = '1';
  };
  node.addEventListener('pointerenter', show);
  node.addEventListener('pointermove', show);
  node.addEventListener('pointerleave', () => (tipEl.style.opacity = '0'));
}

/** Columns: hours per day, one series, so no legend — the title names it. */
function renderDaily(series) {
  const host = $('daily-chart');
  host.textContent = '';
  const total = series.reduce((n, d) => n + d.seconds, 0);
  $('daily-sub').textContent = `${series.length} days · ${fmtDuration(total)} total`;

  if (!total) {
    host.innerHTML = '<div class="empty">No time tracked in this range.</div>';
    return;
  }

  const W = host.clientWidth || 480, H = 200;
  const pad = { top: 18, right: 6, bottom: 22, left: 34 };
  const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom;

  const maxHours = Math.max(...series.map((d) => d.seconds / 3600));
  const ticks = niceTicks(maxHours);
  const top = ticks[ticks.length - 1] || 1;
  const y = (h) => pad.top + plotH - (h / top) * plotH;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' });
  // role="img" makes the SVG a leaf for assistive tech, so per-bar <title>s
  // would never be announced — the summary has to carry the reading itself.
  const busiest = series.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  svg.append(el('title', {}, `Hours tracked per day over ${series.length} days. `
    + `${fmtDuration(total)} in total. `
    + `Busiest day ${labelDay(busiest.day)}, ${fmtDuration(busiest.seconds)}.`));

  for (const t of ticks) {
    svg.append(el('line', {
      x1: pad.left, x2: W - pad.right, y1: y(t), y2: y(t),
      stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
    }));
    svg.append(el('text', { x: pad.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' },
      t % 1 === 0 ? String(t) : t.toFixed(1)));
  }

  // 2px surface gap between adjacent columns; cap thickness at 24px.
  const band = plotW / series.length;
  const barW = Math.max(3, Math.min(24, band - 2));
  // Single series, so no categorical meaning to preserve — this one follows the
  // MD3 primary role rather than a PALETTE slot, and re-reads it per render so
  // the light/dark toggle carries the chart with it.
  const color = cssVar('--md-primary');

  series.forEach((d, i) => {
    const hours = d.seconds / 3600;
    const x = pad.left + band * i + (band - barW) / 2;
    const h = Math.max(hours > 0 ? 2 : 0, (hours / top) * plotH);

    if (h > 0) {
      const bar = el('path', { d: barPath(x, y(hours), barW, h), fill: color });
      bindTip(bar, $('daily-tip'),
        `${labelDay(d.day)}<br><strong>${fmtDuration(d.seconds)}</strong>`);
      svg.append(bar);
    }
    // Label only the extreme — a value on every column goes unread.
    if (d === busiest && d.seconds > 0) {
      svg.append(el('text', {
        x: x + barW / 2, y: y(hours) - 6, 'text-anchor': 'middle', class: 'mark-value',
      }, fmtDuration(d.seconds)));
    }

    const every = Math.ceil(series.length / 8);
    if (i % every === 0 || i === series.length - 1) {
      svg.append(el('text', {
        x: x + barW / 2, y: H - 6, 'text-anchor': 'middle', class: 'tick',
      }, axisDay(d.day)));
    }
  });

  svg.append(el('line', {
    x1: pad.left, x2: W - pad.right, y1: y(0), y2: y(0),
    stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
  }));
  host.append(svg);
}

/**
 * Today's sessions, one row each, on a timeline that spans only the tracked part
 * of the day rather than a fixed 00:00–24:00 — a 09:12–17:43 day filled barely a
 * third of the plot, which is where the gaps you want to read actually live.
 */
function renderGantt(entries) {
  const host = $('daily-chart');
  host.textContent = '';

  const DAY = 86400;
  const [ty, tm, td] = range().from.split('-').map(Number);
  const midnight = new Date(ty, tm - 1, td, 0, 0, 0, 0).getTime();
  const secOfDay = (iso) =>
    Math.min(DAY, Math.max(0, (new Date(iso).getTime() - midnight) / 1000));
  const nowSec = Math.min(DAY, Math.max(0, (Date.now() - midnight) / 1000));

  const rows = entries
    .map((e) => ({ e, start: secOfDay(e.startedAt), end: e.running ? nowSec : secOfDay(e.endedAt) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const total = rows.reduce((n, r) => n + r.e.seconds, 0);
  $('daily-sub').textContent =
    `${rows.length} session${rows.length === 1 ? '' : 's'} · ${fmtDuration(total)} total`;

  if (!rows.length) {
    host.innerHTML = '<div class="empty">No time tracked today.</div>';
    return;
  }

  const W = host.clientWidth || 480;
  const rowH = 24, barH = 12;
  const labelW = Math.min(160, Math.max(90, W * 0.3));
  const pad = { top: 10, right: 10, bottom: 22 };
  const H = pad.top + rows.length * rowH + pad.bottom;
  const plotW = W - labelW - pad.right;

  // Domain = first start to last end (now, for a running timer), rounded outward
  // to the tick step so the labels stay clean and the outer bars keep a margin.
  // `niceTicks` is no help here: its 1/2/2.5/5/10 progression yields decimal
  // steps, and time wants 5m/15m/1h/6h. Budget 50px per "HH:MM" label (~32px at
  // .tick's 11px tabular-nums), so a narrow card coarsens the step instead of
  // colliding labels; `- 1` leaves room for the rounding to add an interval.
  // Every step divides 86400, so `lo` being a multiple of it from local midnight
  // makes every tick a whole clock time.
  const lo0 = rows[0].start, hi0 = Math.max(...rows.map((r) => r.end));
  const maxIntervals = Math.max(3, Math.floor(plotW / 50));
  const step = TIME_STEPS.find((s) => (hi0 - lo0) / s <= maxIntervals - 1)
    ?? TIME_STEPS[TIME_STEPS.length - 1];
  const lo = Math.floor(lo0 / step) * step;
  const hi = Math.ceil(hi0 / step) * step;
  const x = (sec) => labelW + ((sec - lo) / (hi - lo)) * plotW;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' });
  const first = rows[0], last = rows[rows.length - 1];
  svg.append(el('title', {}, `Timeline of ${rows.length} session${rows.length === 1 ? '' : 's'} today, `
    + `${fmtDuration(total)} in total, from ${fmtTime(first.e.startedAt)} to `
    + `${last.e.running ? 'now' : fmtTime(last.e.endedAt)}.`));

  // Gridlines + labels every `step`, drawn under the bars. The edge ticks anchor
  // inward so they don't hang off the plot.
  for (let sec = lo; sec <= hi; sec += step) {
    const gx = x(sec);
    svg.append(el('line', {
      x1: gx, x2: gx, y1: pad.top, y2: H - pad.bottom,
      stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
    }));
    svg.append(el('text', {
      x: gx, y: H - 6, class: 'tick',
      'text-anchor': sec === lo ? 'start' : sec === hi ? 'end' : 'middle',
    }, tickTime(sec)));
  }

  rows.forEach((r, i) => {
    const { e } = r;
    const yTop = pad.top + i * rowH + (rowH - barH) / 2;
    const w = Math.max(2, x(r.end) - x(r.start));
    const label = e.description || e.projectName || e.project;

    svg.append(el('text', {
      x: 0, y: yTop + barH / 2 + 4, class: 'mark-label',
    }, truncate(label, Math.floor(labelW / 7))));

    const bar = el('path', { d: barPath(x(r.start), yTop, w, barH, 4, 'right'), fill: seriesColor(e.color) });
    bindTip(bar, $('daily-tip'),
      `${label}<br>${fmtTime(e.startedAt)}–${e.running ? 'now' : fmtTime(e.endedAt)}`
      + `<br><strong>${fmtDuration(e.seconds)}</strong>`);
    svg.append(bar);
  });

  host.append(svg);
}

function labelDay(key, short = false) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // Day-first, always: we build the numeric part by hand because locale ordering
  // is exactly what we're overriding; weekday/month names still come from locale.
  return short
    ? `${d}/${m}`
    : `${date.toLocaleDateString([], { weekday: 'short' })}, ${d} `
      + `${date.toLocaleDateString([], { month: 'short' })}`;
}

// Weekly-chart x-axis: weekday + day-first date, e.g. "Mon - 20/7".
function axisDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${date.toLocaleDateString([], { weekday: 'short' })} - ${d}/${m}`;
}

/** Horizontal bars by project or tag, with direct labels (the contrast relief). */
function renderProjects(items, total, groupBy = 'project') {
  const host = $('project-chart');
  const legend = $('project-legend');
  host.textContent = '';
  legend.textContent = '';
  $('project-title').textContent = groupBy === 'tag' ? 'Time by tag' : 'Time by project';
  const noun = groupBy === 'tag' ? 'tag' : 'project';
  $('project-sub').textContent = `${items.length} ${noun}${items.length === 1 ? '' : 's'}`;

  if (!items.length) {
    host.innerHTML = '<div class="empty">No time tracked in this range.</div>';
    return;
  }

  // Tag buckets carry no stored colour — assign slots in order, never cycled.
  const shown = items.slice(0, 8).map((it, i) => ({ ...it, color: it.color || PALETTE[i] }));
  const rest = items.slice(8);
  if (rest.length) {
    shown.push({
      key: '__other', label: `Other (${rest.length})`,
      seconds: rest.reduce((n, i) => n + i.seconds, 0), color: null,
    });
  }

  const rowH = 34, W = host.clientWidth || 480;
  const H = shown.length * rowH + 8;
  const labelW = Math.min(140, Math.max(80, W * 0.3));
  const valueW = 62;
  const plotW = W - labelW - valueW;
  const max = Math.max(...shown.map((i) => i.seconds));

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' });
  const lead = shown[0];
  svg.append(el('title', {}, `Time tracked by ${noun}, ${items.length} ${noun}s. `
    + `Largest is ${lead.label || lead.key}, ${fmtDuration(lead.seconds)}`
    + `${total ? ` of ${fmtDuration(total)}` : ''}.`));

  shown.forEach((item, i) => {
    const yTop = i * rowH + 4;
    const barH = Math.min(24, rowH - 12);
    const w = Math.max(item.seconds > 0 ? 2 : 0, (item.seconds / max) * plotW);
    const fill = item.color ? seriesColor(item.color) : 'var(--baseline)';

    svg.append(el('text', {
      x: 0, y: yTop + barH / 2 + 4, class: 'mark-label',
    }, truncate(item.label || item.key, Math.floor(labelW / 7))));

    const bar = el('path', {
      d: barPath(labelW, yTop + (rowH - 8 - barH) / 2, w, barH, 4, 'right'),
      fill,
    });
    const pct = total ? ((item.seconds / total) * 100).toFixed(0) : 0;
    bindTip(bar, $('project-tip'),
      `${item.label || item.key}<br><strong>${fmtDuration(item.seconds)}</strong> · ${pct}%`);
    svg.append(bar);

    svg.append(el('text', {
      x: W, y: yTop + barH / 2 + 4, 'text-anchor': 'end', class: 'mark-value',
    }, fmtDuration(item.seconds)));
  });

  host.append(svg);

  // Legend is always present for >= 2 series: identity never rests on color alone.
  if (shown.length >= 2) {
    for (const item of shown) {
      const s = document.createElement('span');
      const dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.background = item.color ? seriesColor(item.color) : 'var(--baseline)';
      s.append(dot, document.createTextNode(item.label || item.key));
      legend.append(s);
    }
  }
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ----------------------------------------------------------------- render --

// Entries grouping — always two levels, project then description, with no user
// choice: seeing which project the time went to and which task it was are not
// alternatives. Which groups are collapsed is session-only (a Set of prefixed
// keys). lastEntries lets a collapse re-render instantly without another fetch.
const collapsedGroups = new Set();
let lastEntries = [];

/** Seconds of one entry that fall within the given YYYY-MM-DD local day. */
function entrySecondsOn(e, key) {
  const [y, m, d] = key.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d).getTime();
  const dayEnd = dayStart + 86400000;
  const start = new Date(e.startedAt).getTime();
  const end = e.running ? Date.now() : new Date(e.endedAt).getTime();
  return Math.max(0, Math.round((Math.min(end, dayEnd) - Math.max(start, dayStart)) / 1000));
}

// One entry -> one <tr>. `i` is the index in the full started_at DESC list, so
// the "Continue" affordance still keys off the single latest entry no matter
// which group it lands in. Every row sits under a header that already names its
// project, so the project cell is only a quiet indent.
function buildEntryRow(e, i) {
  const tr = document.createElement('tr');

  const proj = document.createElement('td');
  proj.className = 'group-indent';

  const desc = document.createElement('td');
  desc.textContent = e.description || '—';
  if (!e.description) desc.className = 'muted';
  if (e.tags.length) {
    const tags = document.createElement('span');
    tags.className = 'muted';
    tags.textContent = `  ${e.tags.map((t) => `#${t}`).join(' ')}`;
    desc.append(tags);
  }

  const started = document.createElement('td');
  started.className = 'muted';
  const endLabel = e.running ? 'now' : fmtTime(e.endedAt);
  started.textContent =
    `${labelDay(dayKey(new Date(e.startedAt)), true)} ${fmtTime(e.startedAt)} → ${endLabel}`;

  const dur = document.createElement('td');
  dur.className = 'num';
  dur.textContent = e.running ? `${fmtDuration(e.seconds)} …` : fmtDuration(e.seconds);

  const actions = document.createElement('td');
  actions.className = 'row-actions num';
  if (!e.running) {
    // Continue reopens this very entry rather than opening a sibling, so a
    // short break does not fragment one session into a dozen rows. Offered on
    // the latest entry only (the list arrives started_at DESC) and only when
    // nothing else is running — anywhere else it would be reordering history
    // rather than resuming what you were just doing.
    if (i === 0 && !state.running) {
      const cont = document.createElement('button');
      cont.textContent = 'Continue';
      cont.className = 'btn-text state';
      cont.dataset.tip = 'Reopen this entry instead of starting a new one';
      cont.setAttribute('aria-label',
        `Continue the entry for ${e.projectName}${e.description ? `: ${e.description}` : ''}`);
      cont.onclick = async () => {
        const gap = Math.max(0, Math.round((Date.now() - new Date(e.endedAt)) / 1000));
        const mode = await choiceDialog({
          title: 'Continue this entry?',
          message: `${e.projectName}${e.description ? ` · ${e.description}` : ''}`
            + ` · stopped ${fmtDuration(gap)} ago.`
            + ' Counting the break bills it as work; excluding it keeps the'
            + ` ${fmtDuration(e.seconds)} already tracked and resumes from now.`,
          choices: [
            { label: `Include break (${fmtDuration(e.seconds + gap)})`, value: 'include' },
            { label: `Exclude break (${fmtDuration(e.seconds)})`, value: 'exclude' },
          ],
        });
        if (!mode) return;
        try {
          await api(`/entries/${e.id}/continue`, { method: 'POST', body: { mode } });
          toast(`Continuing ${e.projectName}`);
          await refresh();
        } catch (err) {
          toast(err.message);
        }
      };
      actions.append(cont);
    }

    // Pick this task up again. The server's start endpoint defaults startedAt
    // to now and stops whatever was running, so resuming is one call — this
    // deliberately opens a fresh entry rather than reopening the old one, so
    // the original session's times stay intact in the history.
    const again = document.createElement('button');
    again.textContent = 'Start';
    again.className = 'btn-text state';
    again.dataset.tip = 'Start a new, separate timer for this task, beginning now';
    again.setAttribute('aria-label',
      `Start a new timer for ${e.projectName}${e.description ? `: ${e.description}` : ''}`);
    again.onclick = async () => {
      try {
        const res = await api(`/projects/${encodeURIComponent(e.project)}/start`, {
          method: 'POST',
          body: { description: e.description, tags: e.tags },
        });
        // Restarting the same project would otherwise read "Tracking Beta ·
        // stopped Beta", which sounds like a bug rather than a handoff.
        if (!res.stopped) toast(`Tracking ${e.projectName}`);
        else if (res.stopped.project === e.project) toast(`Restarted ${e.projectName}`);
        else toast(`Tracking ${e.projectName} · stopped ${res.stopped.projectName}`);
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    };
    actions.append(again);

    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.className = 'btn-text state';
    edit.setAttribute('aria-label', `Edit entry for ${e.projectName}`);
    edit.onclick = () => openDialog(e);
    actions.append(edit);

    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'btn-text state';
    del.style.color = 'var(--md-error)';
    del.setAttribute('aria-label', `Delete entry for ${e.projectName}`);
    del.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Delete entry?',
        message: `${e.projectName} · ${fmtDuration(e.seconds)}`
          + `${e.description ? ` · ${e.description}` : ''}. This cannot be undone.`,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      await api(`/entries/${e.id}`, { method: 'DELETE' });
      toast('Entry deleted');
      refresh();
    };
    actions.append(del);
  }

  tr.append(proj, desc, started, dur, actions);
  return tr;
}

// A collapsible group header spanning the whole table width, at one of two
// levels. A `project` header carries the project dot and both totals; a
// `description` header sits inside one, so it drops the dot and shows the range
// total alone — its parent's Today figure is already on screen right above it.
function buildGroupHead(items, { label, color, level }, collapsed, onToggle) {
  const rangeSecs = items.reduce((n, { e }) => n + e.seconds, 0);
  const todaySecs = items.reduce((n, { e }) => n + entrySecondsOn(e, dayKey(new Date())), 0);
  const isProject = level === 'project';

  const tr = document.createElement('tr');
  tr.className = `group-head group-head-${level}`;
  const td = document.createElement('td');
  td.colSpan = 5;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `group-btn state group-${level}`;
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label',
    `${collapsed ? 'Expand' : 'Collapse'} ${label}: `
    + (isProject ? `today ${fmtDuration(todaySecs)}, ` : '')
    + `range ${fmtDuration(rangeSecs)}`);
  btn.onclick = onToggle;

  const chevron = document.createElement('span');
  chevron.className = `chevron${collapsed ? '' : ' open'}`;
  chevron.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = label;

  const count = document.createElement('span');
  count.className = 'group-count muted';
  count.textContent = `${items.length} ${items.length === 1 ? 'entry' : 'entries'}`;

  const totals = document.createElement('span');
  totals.className = 'group-totals';
  totals.innerHTML = isProject
    ? `Today <strong>${fmtDuration(todaySecs)}</strong>`
      + ` <span class="muted">·</span> Range <strong>${fmtDuration(rangeSecs)}</strong>`
    : `<strong>${fmtDuration(rangeSecs)}</strong>`;

  btn.append(chevron);
  if (color != null) {
    const dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = seriesColor(color);
    btn.append(dot);
  }
  btn.append(name, count, totals);
  td.append(btn);
  tr.append(td);
  return tr;
}

/** Bucket into a Map, preserving started_at DESC order of first appearance. */
function bucketBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// Toggling collapse re-renders from the cached entries, so it flips with no
// round trip.
function toggleGroup(key) {
  if (collapsedGroups.has(key)) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  renderEntries(lastEntries);
}

// The description groups of one project, appended into its <tbody>. Collapse
// keys are namespaced by level *and* by parent project: the same description
// under two projects must collapse independently.
function appendDescriptionGroups(tbody, slug, items) {
  for (const [desc, group] of bucketBy(items, ({ e }) => e.description || '')) {
    const key = `d:${slug} ${desc}`;
    const collapsed = collapsedGroups.has(key);
    tbody.append(buildGroupHead(
      group,
      { label: desc || '(no description)', color: null, level: 'description' },
      collapsed,
      () => toggleGroup(key),
    ));
    if (!collapsed) for (const { e, i } of group) tbody.append(buildEntryRow(e, i));
  }
}

function renderEntries(entries) {
  lastEntries = entries;
  const host = $('entries-table');
  $('entries-sub').textContent = `${entries.length} in range`;

  if (!entries.length) {
    host.innerHTML = '<div class="empty">Nothing tracked yet. Start a timer above.</div>';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
      <th></th><th>Description</th><th>Started</th>
      <th class="num">Duration</th><th></th>
    </tr></thead>`;

  // Pair each entry with its index in the full started_at DESC list before
  // bucketing, so `i === 0` still identifies the single latest entry wherever it
  // lands. Map order keeps the most recently active group on top at both levels.
  const items = [...entries.entries()].map(([i, e]) => ({ e, i }));

  // A scoped /p/<slug> page is one project by definition, so the outer level
  // would be a single redundant header — group by description alone there.
  if (state.scope) {
    const tbody = document.createElement('tbody');
    tbody.className = 'entry-group';
    appendDescriptionGroups(tbody, '', items);
    table.append(tbody);
  } else {
    // <tbody> cannot nest, so one <tbody> holds a whole project: its header, then
    // each description header with that description's rows. The hierarchy is
    // carried by the level classes, not by markup depth.
    for (const [slug, group] of bucketBy(items, ({ e }) => e.project)) {
      const first = group[0].e;
      const key = `p:${slug}`;
      const collapsed = collapsedGroups.has(key);
      const tbody = document.createElement('tbody');
      tbody.className = 'entry-group';
      tbody.append(buildGroupHead(
        group,
        { label: first.projectName, color: first.color, level: 'project' },
        collapsed,
        () => toggleGroup(key),
      ));
      if (!collapsed) appendDescriptionGroups(tbody, slug, group);
      table.append(tbody);
    }
  }

  // Five columns plus free-text descriptions cannot reflow onto a phone, so the
  // table scrolls inside its card. tabindex makes that scroll reachable by
  // keyboard, which a bare overflow container is not.
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'region');
  scroller.setAttribute('aria-label', 'Tracked entries');
  scroller.append(table);

  host.textContent = '';
  host.append(scroller);
}

function renderTimer() {
  const dot = $('timer-dot');
  const btn = $('toggle-btn');
  const elapsed = $('elapsed');
  const since = $('since');

  if (state.running) {
    const secs = Math.max(0, Math.round((Date.now() - new Date(state.running.startedAt)) / 1000));
    elapsed.textContent = fmtClock(secs);
    elapsed.classList.remove('idle');
    dot.style.background = seriesColor(state.running.color);
    dot.classList.add('pulse');
    btn.textContent = 'Stop';
    btn.className = 'btn-primary btn-stop state';
    document.title = `${fmtDuration(secs)} · ${state.running.projectName}`;

    // Don't fight the user while they are mid-edit in the time field.
    since.hidden = false;
    if (document.activeElement !== $('start-time')) {
      $('start-time').value = timeValue(state.running.startedAt);
    }
  } else {
    since.hidden = true;
    elapsed.textContent = '0:00:00';
    elapsed.classList.add('idle');
    dot.style.background = 'var(--md-on-surface-variant)';
    dot.classList.remove('pulse');
    btn.textContent = 'Start';
    btn.className = 'btn-primary state';
    document.title = state.scope ? `worktime · ${state.scope}` : 'worktime';
  }
}

/**
 * `wt start` drops you here to type a task, so put the caret where typing should
 * begin — the project box, or the note box when the project is already known.
 * Only on first paint, and never while the user is mid-edit elsewhere.
 */
let focused = false;
function focusForInput() {
  if (focused || state.running) return;
  focused = true;
  if (document.activeElement && document.activeElement !== document.body) return;
  const target = state.scope || $('project-input').value ? $('desc-input') : $('project-input');
  target.focus();
}

/**
 * A dead server is the common failure here — the CLI auto-boots one, the
 * dashboard cannot. A toast disappears before it is read and leaves the charts
 * looking merely empty, so the banner persists until a refresh succeeds.
 */
function showError(msg) {
  $('error-text').textContent = msg || '';
  $('error-banner').hidden = !msg;
}

/**
 * Update banner. The server's updateInfo() throttles its own `git fetch`, so
 * this can ride the normal poll cheaply; we still gate to ~15 min between checks
 * and suppress the check entirely while an update is in flight. Update is a
 * nicety — its own failures are swallowed, never shown as a data error.
 */
let lastUpdateCheck = 0;
let updating = false;

async function checkUpdate(force = false) {
  if (updating) return;
  if (!force && Date.now() - lastUpdateCheck < 15 * 60 * 1000) return;
  lastUpdateCheck = Date.now();
  let info;
  try {
    info = await api('/update');
  } catch {
    return;
  }
  const show = info.enabled && info.available;
  $('update-text').textContent = show && info.latest ? `“${info.latest}”` : '';
  $('update-banner').hidden = !show;
}

async function runUpdate() {
  if (updating) return;
  const ok = await confirmDialog({
    title: 'Update now?',
    message: 'Pulls the latest version and restarts the server. Any running timer keeps running.',
    confirmLabel: 'Update',
  });
  if (!ok) return;

  updating = true;
  $('update-btn').disabled = true;
  $('update-text').textContent = 'Updating…';
  // The connection may drop as the server restarts — that's expected, not an error.
  await api('/update', { method: 'POST', body: {} }).catch(() => {});

  // Wait for the server to come back on the new code, then reload onto it.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await api('/health');
      location.reload();
      return;
    } catch {}
  }
  updating = false;
  $('update-btn').disabled = false;
  $('update-text').textContent = 'Restart is taking a while — try again.';
}

/**
 * refresh() reports its own failures and never rejects, so the polling timers
 * and event handlers that call it can stay fire-and-forget.
 */
async function refresh() {
  // Scoped to a project, a "by project" bar chart is one bar about itself —
  // the useful cut there is where the time went, i.e. by tag.
  const groupBy = state.scope ? 'tag' : 'project';
  let payload;
  try {
    payload = await Promise.all([
      api(`/state${state.scope ? `?project=${encodeURIComponent(state.scope)}` : ''}`),
      api(`/reports/summary?${rangeQuery({ groupBy })}`),
      api(`/reports/timeseries?${rangeQuery()}`),
      api(`/entries?${rangeQuery({ limit: 100 })}`),
      api('/projects'),
    ]);
  } catch (err) {
    // Drop the skeleton either way: shimmering forever reads as "still working".
    document.body.classList.remove('is-loading');
    showError(err.message);
    return;
  }
  showError(null);

  const [stateRes, summary, ts, entries, projects] = payload;
  state.running = stateRes.running;
  state.projects = projects;
  state.statuses = stateRes.statuses || [];

  if (state.running) {
    $('project-input').value = state.running.project;
    $('desc-input').value = state.running.description;
    $('tags-input').value = state.running.tags.join(',');
  }

  $('stat-today').textContent = fmtDuration(stateRes.todaySeconds);
  $('stat-week').textContent = fmtDuration(stateRes.weekSeconds);
  $('stat-range').textContent = fmtDuration(summary.totalSeconds);
  $('stat-range-label').textContent =
    state.range === 'today' ? 'Today total' : state.range === 'month' ? 'This month' : 'This week';

  const activeDays = ts.series.filter((d) => d.seconds > 0).length;
  $('stat-avg').textContent = activeDays
    ? `${fmtDuration(Math.round(summary.totalSeconds / activeDays))}`
    : '—';

  renderTimer();
  focusForInput();
  if (state.range === 'today') {
    $('daily-title').textContent = "Today's timeline";
    renderGantt(entries);
  } else {
    $('daily-title').textContent = 'Hours per day';
    renderDaily(ts.series);
  }
  renderProjects(summary.items, summary.totalSeconds, groupBy);
  renderEntries(entries);
  renderPicker(projects);
  document.body.classList.remove('is-loading');
}

/** Built once; refresh() only feeds it new options. */
const projectSelect = createSelect($('project-picker'), {
  label: 'Project',
  onChange: (slug) => {
    location.href = slug ? `/p/${encodeURIComponent(slug)}` : '/';
  },
});

function renderPicker(projects) {
  projectSelect.setOptions([
    { value: '', label: 'All projects' },
    ...projects.map((p) => ({ value: p.slug, label: p.name })),
  ]);
  projectSelect.setValue(state.scope || '');
  $('scope').textContent = state.scope ? `· ${state.scope}` : '';
}

// ---- statuses -------------------------------------------------------------
// Statuses are report-only: they are picked per task in the daily report modal
// and never written back to an entry. Names added there live for the session;
// ones already stored on old entries come back from /api/state.
const customStatuses = new Set();

/** Deduped, ordered status values: defaults, then server- and session-added. */
function statusValues() {
  const seen = new Set();
  const out = [];
  for (const s of [...DEFAULT_STATUSES, ...(state.statuses || []), ...customStatuses]) {
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// ------------------------------------------------------------------ wiring --

$('toggle-btn').onclick = async () => {
  try {
    if (state.running) {
      await api('/stop', { method: 'POST', body: {} });
      toast('Timer stopped');
    } else {
      const project = ($('project-input').value || state.scope || '').trim();
      if (!project) return toast('Pick a project first');
      await api(`/projects/${encodeURIComponent(project)}/start`, {
        method: 'POST',
        body: { description: $('desc-input').value, tags: $('tags-input').value },
      });
      toast(`Tracking ${project}`);
    }
    await refresh();
  } catch (err) {
    toast(err.message);
  }
};

/**
 * Adjust the running timer's start time — the "I forgot to hit start 20 minutes
 * ago" fix. The date comes from the existing start, so only the clock changes;
 * a time later than now would mean negative elapsed, so we roll it back a day
 * (you started last night) rather than rejecting it.
 */
$('start-time').addEventListener('change', async (e) => {
  if (!state.running) return;
  const value = e.target.value;
  if (!value) return renderTimer();

  const current = new Date(state.running.startedAt);
  const iso = localISO(dayKey(current), value);
  if (!iso) return renderTimer();
  let next = new Date(iso);
  if (next > new Date()) next = new Date(next.getTime() - 86400000);

  try {
    await api(`/entries/${state.running.id}`, {
      method: 'PATCH',
      body: { startedAt: next.toISOString() },
    });
    toast(`Start time set to ${fmtTime(next.toISOString())}`);
    await refresh();
  } catch (err) {
    toast(err.message);
    renderTimer();
  }
});

// ---- add / edit entry dialog ----------------------------------------------

const dialog = $('entry-dialog');
const form = $('entry-form');
let editingId = null;

/** Switch the dialog between explicit Start/End and split Hours/Minutes fields.
 *  `required` has to move with visibility: a hidden required input blocks submit. */
function setDialogMode(mode, { seconds, focus } = {}) {
  form.dataset.mode = mode;
  const times = mode === 'times';
  $('field-start').hidden = $('field-end').hidden = !times;
  $('field-duration-h').hidden = $('field-duration-m').hidden = times;
  form.start.required = form.end.required = times;
  $('duration-switch').setAttribute('aria-checked', String(!times));
  // Seed Hours/Minutes from the current start/end when arriving in duration mode.
  if (!times && seconds != null) {
    form.durationH.value = Math.floor(seconds / 3600);
    form.durationM.value = Math.round((seconds % 3600) / 60);
  }
  if (focus) (times ? form.start : form.durationH).focus();
}

function openDialog(entry) {
  editingId = entry ? entry.id : null;
  $('dialog-title').textContent = entry ? 'Edit entry' : 'Add entry';
  $('dialog-error').hidden = true;

  const now = new Date();
  const start = entry ? new Date(entry.startedAt) : new Date(now.getTime() - 3600000);
  const end = entry?.endedAt ? new Date(entry.endedAt) : now;

  form.project.value = entry ? entry.project : state.scope || $('project-input').value || '';
  form.description.value = entry ? entry.description : '';
  form.tags.value = entry ? entry.tags.join(', ') : '';
  form.date.value = dayKey(start);
  form.start.value = timeValue(start);
  form.end.value = timeValue(end);
  form.durationH.value = '';
  form.durationM.value = '';

  // The dialog always opens on explicit Start/End; the switch reveals Duration.
  setDialogMode('times');

  dialog.showModal();
  (form.project.value ? form.description : form.project).focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  // No status/percent/eta here — those are report-only now, so a PATCH that
  // omits them leaves whatever an older build stored untouched.
  const body = {
    project: form.project.value.trim(),
    description: form.description.value.trim(),
    tags: form.tags.value,
  };

  const dialogError = (message) => {
    $('dialog-error').textContent = message;
    $('dialog-error').hidden = false;
  };

  if (form.dataset.mode === 'duration') {
    const h = parseInt(form.durationH.value, 10) || 0;
    const m = parseInt(form.durationM.value, 10) || 0;
    const seconds = h * 3600 + m * 60;
    if (seconds <= 0) return dialogError('Enter hours or minutes.');
    // The entry ends at the current time-of-day on the chosen date and runs back
    // from there. On a past date that can cross midnight; the report layer splits
    // such a session across both days, so it still lands correctly.
    body.endedAt = localISO(form.date.value, timeValue(new Date()));
    if (!body.endedAt) return dialogError('Enter a valid date.');
    if (editingId) body.startedAt = new Date(new Date(body.endedAt).getTime() - seconds * 1000).toISOString();
    else body.duration = `${h}h ${m}m`;
  } else {
    body.startedAt = localISO(form.date.value, form.start.value);
    // An end before the start means the session ran past midnight.
    body.endedAt = localISO(form.date.value, form.end.value);
    if (!body.startedAt || !body.endedAt) return dialogError('Enter a valid date and time.');
    if (new Date(body.endedAt) <= new Date(body.startedAt)) {
      body.endedAt = new Date(new Date(body.endedAt).getTime() + 86400000).toISOString();
    }
  }

  try {
    if (editingId) await api(`/entries/${editingId}`, { method: 'PATCH', body });
    else await api('/entries', { method: 'POST', body });
    dialog.close();
    toast(editingId ? 'Entry updated' : 'Entry added');
    await refresh();
  } catch (err) {
    $('dialog-error').textContent = err.message;
    $('dialog-error').hidden = false;
  }
});

// ---- daily report ---------------------------------------------------------
// A standup line per task, where a "task" is one description (the Linear URL)
// with every entry against it today summed. Nothing here is persisted: the
// modal exists to produce text, so it holds its own state and forgets it on
// close.

const reportDialog = $('report-dialog');
let reportRows = [];

/** A labelled MD3 text field, matching the ones authored in index.html. */
function reportField(id, label, type = 'text') {
  const field = document.createElement('div');
  field.className = 'field dense';
  const input = document.createElement('input');
  input.id = id;
  input.type = type;
  input.placeholder = ' ';
  if (type === 'number') { input.min = '0'; input.max = '100'; }
  const lab = document.createElement('label');
  lab.setAttribute('for', id);
  lab.textContent = label;
  field.append(input, lab);
  return { field, input };
}

const statusOptions = () => [
  ...statusValues().map((s) => ({ value: s, label: s })),
  { value: ADD_STATUS, label: '+ Add new status…' },
];

/** A new status is offered to every task, not just the row that added it. */
function rebuildReportOptions() {
  for (const row of reportRows) row.select.setOptions(statusOptions());
}

function reportLine(row) {
  const spent = `${(row.seconds / 3600).toFixed(2)}h`;
  const status = row.select.value;
  if (status !== 'WIP') return `- ${row.label} => ${status}, spent: ${spent}`;

  const pct = row.percent.value.trim();
  const eta = row.eta.value.trim();
  return `- ${row.label} => WIP${pct ? ` ${pct}%` : ''}, spent: ${spent}`
    + (eta ? `, eta: ${eta}` : '');
}

/**
 * Time across the tasks you are including, which is what the report speaks for.
 * Deliberately not gated on status the way the preview lines are: a row you
 * kept but have not labelled yet is still time you worked today.
 */
function renderTotal() {
  const seconds = reportRows
    .filter((r) => r.include.checked)
    .reduce((sum, r) => sum + r.seconds, 0);
  $('report-total').hidden = reportRows.length === 0;
  $('report-total-value').textContent = `${fmtDuration(seconds)} · ${(seconds / 3600).toFixed(2)}h`;
}

/** Rows without a status say nothing worth reporting, so they drop out. */
function renderPreview() {
  $('report-preview').value = reportRows
    .filter((r) => r.include.checked && r.select.value && r.select.value !== ADD_STATUS)
    .map(reportLine)
    .join('\n');
  renderTotal();
}

function buildReportRow(label, seconds, index) {
  const wrap = document.createElement('div');
  wrap.className = 'report-row';

  const include = document.createElement('input');
  include.type = 'checkbox';
  include.className = 'report-include';
  include.checked = true;
  include.id = `report-inc-${index}`;

  const name = document.createElement('label');
  name.className = 'report-label';
  name.setAttribute('for', include.id);
  name.textContent = label;

  const dur = document.createElement('span');
  dur.className = 'report-duration';
  dur.textContent = fmtDuration(seconds);

  const controls = document.createElement('div');
  controls.className = 'report-controls';
  const mount = document.createElement('div');
  mount.id = `report-status-${index}`;
  const wip = document.createElement('div');
  wip.className = 'report-wip';
  wip.hidden = true;
  const percent = reportField(`report-pct-${index}`, 'Percent', 'number');
  const eta = reportField(`report-eta-${index}`, 'ETA');
  wip.append(percent.field, eta.field);
  controls.append(mount, wip);

  wrap.append(include, name, dur, controls);

  const row = {
    label, seconds, include, percent: percent.input, eta: eta.input, select: null,
  };

  // Same "+ Add new status…" contract as the old entry dialog: picking it
  // prompts for a name and falls back to the previous value if cancelled.
  let prev = '';
  row.select = createSelect(mount, {
    label: 'Status',
    onChange: async (value) => {
      if (value === ADD_STATUS) {
        const nameValue = await promptDialog({
          title: 'Add status',
          label: 'Status name',
          confirmLabel: 'Add',
        });
        if (nameValue) {
          customStatuses.add(nameValue);
          rebuildReportOptions();
          row.select.setValue(nameValue);
          prev = nameValue;
        } else {
          row.select.setValue(prev);
        }
      } else {
        prev = value;
      }
      wip.hidden = row.select.value !== 'WIP';
      renderPreview();
    },
  });
  row.select.setOptions(statusOptions());

  include.addEventListener('change', renderPreview);
  for (const input of [percent.input, eta.input]) {
    input.addEventListener('input', renderPreview);
  }
  return { wrap, row };
}

async function openReport() {
  const host = $('report-list');
  host.textContent = '';
  reportRows = [];
  $('report-preview').value = '';
  $('report-total').hidden = true;
  $('report-sub').textContent = 'Loading…';
  reportDialog.showModal();

  // Today only, whatever range the chips are on — a standup is about today.
  const day = dayKey(new Date());
  let entries;
  try {
    const q = new URLSearchParams({ from: day, to: day });
    if (state.scope) q.set('project', state.scope);
    entries = await api(`/entries?${q}`);
  } catch (err) {
    $('report-sub').textContent = err.message;
    return;
  }

  // One line per description; entries with none fall back to their project so
  // they are still reportable.
  const totals = new Map();
  for (const e of entries) {
    const label = e.description.trim() || e.projectName;
    // A task spans several entries, so it "ends" at the last one you touched.
    // A running entry has no endedAt but is ending now — the same convention
    // reports.js clips with — which sorts it last, where in-progress belongs.
    const end = e.endedAt ? Date.parse(e.endedAt) : Date.now();
    const prev = totals.get(label);
    if (prev) {
      prev.seconds += e.seconds;
      prev.end = Math.max(prev.end, end);
    } else {
      totals.set(label, { seconds: e.seconds, end });
    }
  }
  // Earliest finish first, so the report reads in the order the day happened.
  const tasks = [...totals].sort((a, b) => a[1].end - b[1].end);

  $('report-sub').textContent = tasks.length
    ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} today`
    : 'Nothing tracked today.';

  let i = 0;
  for (const [label, { seconds }] of tasks) {
    const { wrap, row } = buildReportRow(label, seconds, i++);
    host.append(wrap);
    reportRows.push(row);
  }
  renderTotal();
}

$('report-btn').onclick = openReport;
$('report-close').onclick = () => reportDialog.close();
$('report-copy').onclick = async () => {
  const text = $('report-preview').value;
  if (!text) return toast('Pick a status first');
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    // Clipboard access can be denied; the textarea is still there to copy from.
    $('report-preview').select();
    toast("Couldn't copy — press ⌘C");
  }
};

// ------------------------------------------------------------------- wip --
// "Report WIP" writes today's report into the signed-in user's row of the team's
// monthly Google Sheet, via /api/wip/*. The sheet link/id lives in localStorage
// (per-device, like the theme); everything below is gated on being signed in,
// since the server needs the user's Google token to read or write the sheet.

const SHEET_KEY = 'wt-sheet';
const sheetId = () => localStorage.getItem(SHEET_KEY) || '';

/** Accept a full docs.google.com link or a bare id; null if it's neither. */
function parseSheetIdClient(input) {
  const t = String(input || '').trim();
  const m = t.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]+$/.test(t) ? t : null;
}

/** Toggle the top-center title bar and the Report WIP button for the current
 *  sign-in + configured-sheet state, then (re)load the title. */
function renderWip() {
  const loggedIn = !!state.user;
  const id = sheetId();
  $('wip-bar').hidden = !loggedIn;
  $('report-wip-btn').hidden = !loggedIn || !id;
  if (!loggedIn) return;

  $('wip-set-btn').hidden = !!id;
  $('wip-title').hidden = !id;
  if (id) {
    $('wip-title').textContent = 'Loading sheet…';
    $('wip-title').classList.remove('warn');
    loadWipTitle(id);
  }
}

async function loadWipTitle(id) {
  const el = $('wip-title');
  try {
    const { title, monthOk, month } = await api(`/wip/title?id=${encodeURIComponent(id)}`);
    el.textContent = title || 'Untitled sheet';
    el.classList.toggle('warn', !monthOk);
    el.dataset.tip = monthOk ? 'Change the WIP sheet' : `Not ${month} — reporting is blocked`;
    if (!monthOk) toast(`WIP sheet isn't ${month} — set the current month's file`);
  } catch (err) {
    el.textContent = 'Sheet unavailable';
    el.classList.add('warn');
    toast(err.message);
  }
}

async function promptForSheet() {
  const input = await promptDialog({
    title: 'WIP sheet',
    label: 'Google Sheet link or ID',
    placeholder: 'https://docs.google.com/spreadsheets/d/…',
    confirmLabel: 'Save',
    initial: sheetId(),
  });
  if (input == null) return;
  const id = parseSheetIdClient(input);
  if (!id) return toast("That doesn't look like a Sheet link or ID");
  localStorage.setItem(SHEET_KEY, id);
  renderWip();
}

/**
 * Push the edited Daily-report preview into the user's row of the team sheet.
 * The preview textarea is the source of truth — the user has previewed and
 * edited it — and it lands in column D only ("What I have done for today").
 */
async function reportWipToSheet() {
  const content = $('report-preview').value.trim();
  if (!content) return toast('Nothing to report — pick a status first');

  const id = sheetId();
  if (!id) return promptForSheet();

  let data;
  try {
    data = await api(`/wip/row?id=${encodeURIComponent(id)}`);
  } catch (err) {
    return toast(err.message);
  }
  if (!data.monthOk) return toast(`WIP sheet isn't ${data.month} — nothing was written`);

  const cands = data.candidates || [];
  if (cands.length === 0) return toast('Could not find your row in the sheet');

  let picked = cands[0];
  if (cands.length > 1) {
    // "double check team": several rows share the name, so let the user confirm
    // by team before anything is written.
    const choice = await choiceDialog({
      title: 'Which row is yours?',
      message: 'Several rows match your name — pick your team.',
      choices: cands.map((c, i) => ({ label: `${c.team || '—'} · ${c.name}`, value: String(i) })),
    });
    if (choice == null) return;
    picked = cands[Number(choice)];
  }

  const btn = $('report-wip-btn');
  btn.disabled = true;
  try {
    await api('/wip/report', {
      method: 'POST',
      body: { id, tab: data.tab, rowNumber: picked.rowNumber, content },
    });
    reportDialog.close();
    toast('Reported to the WIP sheet');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

$('report-wip-btn').onclick = reportWipToSheet;
$('wip-set-btn').onclick = promptForSheet;
$('wip-title').onclick = promptForSheet;

$('retry-btn').onclick = async (e) => {
  e.target.disabled = true;
  await refresh();
  e.target.disabled = false;
};

$('add-btn').onclick = () => openDialog(null);
$('dialog-cancel').onclick = () => dialog.close();

$('duration-switch').onclick = () => {
  if (form.dataset.mode === 'duration') {
    setDialogMode('times', { focus: true });
    return;
  }
  // Turning the switch on: seed Hours/Minutes from whatever Start/End currently
  // hold — or from nothing, when either field is blank or unparseable.
  const start = localISO(form.date.value, form.start.value);
  let end = localISO(form.date.value, form.end.value);
  if (!start || !end) return setDialogMode('duration', { seconds: null, focus: true });
  if (new Date(end) <= new Date(start)) end = new Date(new Date(end).getTime() + 86400000).toISOString();
  const seconds = Math.round((new Date(end) - new Date(start)) / 1000);
  setDialogMode('duration', { seconds: seconds > 0 ? seconds : null, focus: true });
};

// Custom MD3 controls stand in for the native <select>, <datalist> and
// date/time pickers. Each keeps the same value format the API already speaks,
// so nothing downstream had to change.
const projectSlugs = () => state.projects.map((p) => p.slug);
attachAutocomplete($('project-input'), projectSlugs);
attachAutocomplete(form.project, projectSlugs);
attachDatePicker(form.date);
attachTimePicker(form.start);
attachTimePicker(form.end);
attachTimePicker($('start-time'));
initTooltips();

// Type the task, hit Enter, tracking starts — no reach for the mouse.
for (const id of ['project-input', 'desc-input', 'tags-input']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('toggle-btn').click();
    }
  });
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.onclick = () => {
    state.range = chip.dataset.range;
    for (const c of document.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c === chip));
    refresh();
  };
}

$('export-btn').onclick = () => {
  location.href = `/api/reports/entries.csv?${rangeQuery()}`;
};

$('theme-toggle').onclick = () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('wt-theme', next);
  refresh();
};

// --------------------------------------------------------------- account --
// Sign-in is optional and identity-only — nothing in the dashboard is gated on
// it. /api/auth/me reports enabled:false when the server has no GOOGLE_OAUTH_*
// configured, and then neither button ever appears, so the header never hints
// at a feature that cannot work.

const accountDialog = $('account-dialog');

function renderAuth({ enabled, user }) {
  state.user = user || null;
  $('signin-btn').hidden = !enabled || !!user;
  $('avatar-btn').hidden = !user;
  renderWip();
  if (!user) return;

  const label = user.name || user.email || 'Account';
  $('avatar-btn').setAttribute('aria-label', `Account: ${label}`);
  $('avatar-btn').replaceChildren(avatarFace(user));
  $('account-avatar').replaceChildren(avatarFace(user));
  $('account-name').textContent = label;
  $('account-email').textContent = user.email || '';
}

/** Google's photo host can 404 or be blocked outright — fall back to an initial. */
function avatarFace(user) {
  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
  if (!user.picture) return document.createTextNode(initial);
  const img = document.createElement('img');
  img.src = user.picture;
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => img.replaceWith(document.createTextNode(initial));
  return img;
}

async function loadAuth() {
  try {
    renderAuth(await api('/auth/me'));
  } catch {
    renderAuth({ enabled: false, user: null });
  }
}

$('signin-btn').onclick = () => {
  // Full navigation, not fetch: the consent screen is Google's own page.
  const next = location.pathname + location.search;
  location.href = `/api/auth/google?next=${encodeURIComponent(next)}`;
};

$('avatar-btn').onclick = () => accountDialog.showModal();
$('account-close').onclick = () => accountDialog.close();

$('logout-btn').onclick = async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
    accountDialog.close();
    renderAuth({ enabled: true, user: null });
    toast('Signed out');
  } catch (err) {
    toast(err.message);
  }
};

// The callback bounces back here with ?auth_error=… when sign-in fails; say so
// once, then scrub the parameter so a reload doesn't repeat it.
const authError = new URLSearchParams(location.search).get('auth_error');
if (authError) {
  toast(authError);
  const clean = new URL(location.href);
  clean.searchParams.delete('auth_error');
  history.replaceState(null, '', clean);
}

loadAuth();

// ?theme=light|dark forces a mode for screenshots and embeds; otherwise the
// saved choice wins, and with neither we follow the OS.
const urlTheme = new URLSearchParams(location.search).get('theme');
const savedTheme = urlTheme || localStorage.getItem('wt-theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.dataset.theme = savedTheme;
}

if (state.scope) $('project-input').value = state.scope;

// Keep the elapsed clock live without re-fetching the whole dashboard.
state.tick = setInterval(() => state.running && renderTimer(), 1000);

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refresh, 200);
});

// Re-sync when the tab comes back — another device or the CLI may have changed things.
addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
setInterval(() => !document.hidden && refresh(), 60000);

$('update-btn').addEventListener('click', runUpdate);
// Piggyback the update check on the poll; checkUpdate() self-throttles to ~15 min.
setInterval(() => !document.hidden && checkUpdate(), 60000);

refresh();
checkUpdate();

/**
 * MD3 ripple. Delegated from the document so dynamically rendered rows get it
 * for free, and skipped under reduced-motion — the CSS state layer still gives
 * those users hover/focus/press feedback, just without the expanding circle.
 */
addEventListener('pointerdown', (e) => {
  const host = e.target.closest?.('.state');
  if (!host || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const box = host.getBoundingClientRect();
  const size = Math.max(box.width, box.height) * 2;
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.width = span.style.height = `${size}px`;
  span.style.left = `${e.clientX - box.left - size / 2}px`;
  span.style.top = `${e.clientY - box.top - size / 2}px`;
  host.append(span);
  span.addEventListener('animationend', () => span.remove());
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
