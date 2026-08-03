// Google Sheets API v4 client for the WIP daily-report feature.
//
// Zero dependencies: like src/auth.js this uses the global `fetch`. Every call
// takes an already-valid access token (see auth.getGoogleAccessToken) — this
// module knows nothing about OAuth, only about talking to the Sheets API and the
// pure text munging around it (which is what the tests exercise directly).
import { HttpError } from './db.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

// --------------------------------------------------------------- pure bits --

/**
 * Pull a spreadsheet id out of whatever the user pasted — a full
 * `docs.google.com/spreadsheets/d/<id>/edit` URL or a bare id. Returns null when
 * nothing id-shaped is present.
 */
export function parseSheetId(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const inUrl = text.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (inUrl) return inUrl[1];
  return /^[a-zA-Z0-9-_]+$/.test(text) ? text : null;
}

/**
 * Does a spreadsheet title name the same month as `date`? The team keeps one
 * file per month ("WIP - JUL 2026 - ...") and reporting into the wrong month's
 * file is the mistake this guards against. Returns the expected label too, for
 * the warning message. Match is loose on purpose: the title just has to contain
 * the current month's 3-letter abbreviation and year somewhere — which also
 * matches the old full-name form ("JULY" contains "JUL").
 */
export function monthMatches(title, date = new Date()) {
  const name = MONTHS[date.getMonth()];
  const year = String(date.getFullYear());
  const month = `${name} ${year}`;
  const upper = String(title || '').toUpperCase();
  const ok = upper.includes(name) && upper.includes(year);
  return { ok, month };
}

/** Alphanumeric tokens of a string, accent-folded and lowercased. */
function tokenize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Same as tokenize but with any "(nickname)" stripped first. */
function coreTokens(s) {
  return tokenize(String(s || '').replace(/\([^)]*\)/g, ' '));
}

const subset = (a, b) => a.length > 0 && a.every((t) => b.includes(t));

/**
 * Find the rows of a sheet whose "Staff's name" column (col B) name the signed-in
 * user. `rows` is the raw 2-D array from values.get; col A is Team, col B is the
 * name (often "Full Name (Nickname)"). A row matches when the user's name tokens
 * are a subset of the row's (nickname included), or the row's core name is a
 * subset of the user's — so "Bui Quang Huy", "Huy Bui" and "Alan" all hit the
 * "Bui Quang Huy (Alan)" row. When several match, the caller disambiguates by
 * team. `rowNumber` is the 1-based spreadsheet row (values.get starts at row 1).
 */
export function matchRows(rows, name) {
  const userTokens = tokenize(name);
  if (userTokens.length === 0) return [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const cols = rows[i] || [];
    const person = cols[1];
    if (!person || !String(person).trim()) continue;
    const rowTokens = tokenize(person);
    if (subset(userTokens, rowTokens) || subset(coreTokens(person), userTokens)) {
      out.push({ team: cols[0] || '', name: String(person), rowNumber: i + 1, cols });
    }
  }
  return out;
}

/**
 * Pick the tab holding today's entries. Google names a CSV export
 * "<SpreadsheetTitle> - <TabName>.csv", and the sample tab was "20" — the day of
 * the month. Match the day (padded or not); fall back to the first tab.
 */
export function todayTab(tabs, date = new Date()) {
  const day = date.getDate();
  const wanted = new Set([String(day), String(day).padStart(2, '0')]);
  const hit = tabs.find((t) => wanted.has(String(t).trim()));
  return hit ?? tabs[0] ?? null;
}

// --------------------------------------------------------------- API calls --

async function call(token, path, init = {}) {
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const payload = await res.json().catch(() => ({}));
  if (res.ok) return payload;

  const detail = payload?.error?.message || res.status;
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(403, `Google denied access to the sheet: ${detail}`);
  }
  if (res.status === 404) throw new HttpError(404, 'sheet not found — check the link/id');
  throw new HttpError(502, `Google Sheets error: ${detail}`);
}

/** Spreadsheet title + tab names, no cell data. */
export async function getMeta(token, id) {
  const data = await call(
    token,
    `/${encodeURIComponent(id)}?fields=properties.title,sheets.properties.title`,
  );
  return {
    title: data.properties?.title || '',
    tabs: (data.sheets || []).map((s) => s.properties?.title).filter(Boolean),
  };
}

/** All cell values of a tab as a 2-D array (empty when the tab is blank). */
export async function getRows(token, id, tab) {
  const range = encodeURIComponent(tab);
  const data = await call(token, `/${encodeURIComponent(id)}/values/${range}`);
  return data.values || [];
}

/**
 * Overwrite one row's cells. `range` is A1 notation including the tab, e.g.
 * "20!C7:F7"; `row` is the array of cell values to write left-to-right.
 */
export async function updateRow(token, id, range, row) {
  return call(
    token,
    `/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ range, values: [row] }) },
  );
}

/** "20!C7:F7" — quote a tab name that isn't a bare number/word. */
export function a1(tab, cols, rowNumber) {
  const name = /^[A-Za-z0-9]+$/.test(tab) ? tab : `'${String(tab).replace(/'/g, "''")}'`;
  return `${name}!${cols[0]}${rowNumber}:${cols[1]}${rowNumber}`;
}
