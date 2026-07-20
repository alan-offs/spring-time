// worktime — dashboard client.
// The project scope comes straight off the URL: /p/<slug> tracks one project,
// / is the all-projects view.

import {
  createSelect, attachAutocomplete, attachDatePicker, attachTimePicker,
  confirmDialog, choiceDialog, initTooltips,
} from './md.js';

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
  days: 7,
  running: null,
  projects: [],
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

/** "YYYY-MM-DD" + "HH:MM" (local) -> ISO. */
function localISO(day, time) {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
}

function range() {
  const to = dayKey(new Date());
  return { from: shiftDay(to, -(state.days - 1)), to };
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
      }, labelDay(d.day, true)));
    }
  });

  svg.append(el('line', {
    x1: pad.left, x2: W - pad.right, y1: y(0), y2: y(0),
    stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
  }));
  host.append(svg);
}

function labelDay(key, short = false) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return short
    ? date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
    : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
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

function renderEntries(entries) {
  const host = $('entries-table');
  $('entries-sub').textContent = `${entries.length} in range`;

  if (!entries.length) {
    host.innerHTML = '<div class="empty">Nothing tracked yet. Start a timer above.</div>';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
      <th>Project</th><th>Description</th><th>Started</th>
      <th class="num">Duration</th><th></th>
    </tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const [i, e] of entries.entries()) {
    const tr = document.createElement('tr');

    const proj = document.createElement('td');
    const cell = document.createElement('span');
    cell.className = 'proj-cell';
    const dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = seriesColor(e.color);
    const link = document.createElement('a');
    link.href = `/p/${encodeURIComponent(e.project)}`;
    link.textContent = e.projectName;
    cell.append(dot, link);
    proj.append(cell);

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
    started.textContent = `${labelDay(dayKey(new Date(e.startedAt)), true)} ${fmtTime(e.startedAt)}`;

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
    tbody.append(tr);
  }

  table.append(tbody);

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

  if (state.running) {
    $('project-input').value = state.running.project;
    $('desc-input').value = state.running.description;
    $('tags-input').value = state.running.tags.join(',');
  }

  $('stat-today').textContent = fmtDuration(stateRes.todaySeconds);
  $('stat-week').textContent = fmtDuration(stateRes.weekSeconds);
  $('stat-range').textContent = fmtDuration(summary.totalSeconds);
  $('stat-range-label').textContent = state.days === 1 ? 'Today total' : `Last ${state.days} days`;

  const activeDays = ts.series.filter((d) => d.seconds > 0).length;
  $('stat-avg').textContent = activeDays
    ? `${fmtDuration(Math.round(summary.totalSeconds / activeDays))}`
    : '—';

  renderTimer();
  focusForInput();
  renderDaily(ts.series);
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
  let next = new Date(localISO(dayKey(current), value));
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

  dialog.showModal();
  (form.project.value ? form.description : form.project).focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const startedAt = localISO(form.date.value, form.start.value);
  // An end before the start means the session ran past midnight.
  let endedAt = localISO(form.date.value, form.end.value);
  if (new Date(endedAt) <= new Date(startedAt)) {
    endedAt = new Date(new Date(endedAt).getTime() + 86400000).toISOString();
  }

  const body = {
    project: form.project.value.trim(),
    description: form.description.value.trim(),
    tags: form.tags.value,
    startedAt,
    endedAt,
  };

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

$('retry-btn').onclick = async (e) => {
  e.target.disabled = true;
  await refresh();
  e.target.disabled = false;
};

$('add-btn').onclick = () => openDialog(null);
$('dialog-cancel').onclick = () => dialog.close();

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
    state.days = Number(chip.dataset.days);
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

refresh();

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
