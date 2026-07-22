import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, handle, ensureProject, slugify } from '../src/db.js';
import { createServer } from '../src/server.js';
import { summarize, timeseries, dayKey, addDays, weekStart, toCSV, parseDuration } from '../src/reports.js';

const iso = (day, h, m = 0) => {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).toISOString();
};

function addEntry(slug, day, startHour, endHour, tags = '') {
  const p = ensureProject(slug);
  handle()
    .prepare('INSERT INTO entries (project_id, description, tags, started_at, ended_at) VALUES (?,?,?,?,?)')
    .run(p.id, 'x', tags, iso(day, startHour), iso(day, endHour));
}

let server;
let base;

before(async () => {
  const dbFile = join(tmpdir(), `worktime-test-${process.pid}-${Date.now()}.db`);
  open(dbFile);
  // createServer re-opens the same file; the HTTP tests and the direct
  // report calls therefore share one database.
  server = createServer({ dbFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

beforeEach(() => {
  handle().exec('DELETE FROM entries; DELETE FROM projects;');
});

describe('slugify', () => {
  test('normalizes free text to a URL-safe slug', () => {
    assert.equal(slugify('Acme API'), 'acme-api');
    assert.equal(slugify('  Client / Zeta!! '), 'client-zeta');
    assert.equal(slugify('Café Déjà'), 'cafe-deja');
    assert.equal(slugify('already-fine'), 'already-fine');
  });
});

describe('ensureProject', () => {
  test('is idempotent — the same slug never creates a second project', () => {
    const a = ensureProject('Acme API');
    const b = ensureProject('acme-api');
    assert.equal(a.id, b.id);
    assert.equal(handle().prepare('SELECT COUNT(*) n FROM projects').get().n, 1);
  });

  test('assigns categorical slots in fixed order', () => {
    assert.equal(ensureProject('one').color, '#2a78d6');
    assert.equal(ensureProject('two').color, '#008300');
    assert.equal(ensureProject('three').color, '#e87ba4');
  });
});

describe('summarize', () => {
  test('totals by project', () => {
    addEntry('alpha', '2026-03-10', 9, 11);
    addEntry('alpha', '2026-03-10', 13, 14);
    addEntry('beta', '2026-03-10', 15, 16);

    const r = summarize({ from: '2026-03-10', to: '2026-03-10' });
    assert.equal(r.totalSeconds, 4 * 3600);
    assert.deepEqual(r.items.map((i) => [i.key, i.seconds]), [['alpha', 3 * 3600], ['beta', 3600]]);
  });

  test('excludes entries outside the window', () => {
    addEntry('alpha', '2026-03-09', 9, 17);
    addEntry('alpha', '2026-03-10', 9, 10);
    assert.equal(summarize({ from: '2026-03-10', to: '2026-03-10' }).totalSeconds, 3600);
  });

  test('clips an entry that starts before the window', () => {
    // 22:00 the previous day -> 02:00, so only 2h falls inside 03-10.
    const p = ensureProject('alpha');
    handle()
      .prepare('INSERT INTO entries (project_id, tags, started_at, ended_at) VALUES (?,?,?,?)')
      .run(p.id, '', iso('2026-03-09', 22), iso('2026-03-10', 2));

    assert.equal(summarize({ from: '2026-03-10', to: '2026-03-10' }).totalSeconds, 2 * 3600);
    assert.equal(summarize({ from: '2026-03-09', to: '2026-03-09' }).totalSeconds, 2 * 3600);
  });

  test('splits a midnight-spanning entry across both days', () => {
    const p = ensureProject('alpha');
    handle()
      .prepare('INSERT INTO entries (project_id, tags, started_at, ended_at) VALUES (?,?,?,?)')
      .run(p.id, '', iso('2026-03-09', 22), iso('2026-03-10', 2));

    const days = summarize({ from: '2026-03-09', to: '2026-03-10', groupBy: 'day' });
    assert.deepEqual(days.items.map((i) => [i.key, i.seconds]), [
      ['2026-03-09', 2 * 3600],
      ['2026-03-10', 2 * 3600],
    ]);
    assert.equal(days.totalSeconds, 4 * 3600);
  });

  test('filters by project', () => {
    addEntry('alpha', '2026-03-10', 9, 11);
    addEntry('beta', '2026-03-10', 9, 10);
    const r = summarize({ from: '2026-03-10', to: '2026-03-10', project: 'alpha' });
    assert.equal(r.totalSeconds, 2 * 3600);
    assert.equal(r.items.length, 1);
  });

  test('splits multi-tagged time so the tag totals still sum to the whole', () => {
    addEntry('alpha', '2026-03-10', 9, 11, 'build,deep'); // 2h over two tags
    const r = summarize({ from: '2026-03-10', to: '2026-03-10', groupBy: 'tag' });
    assert.deepEqual(r.items.map((i) => [i.key, i.seconds]).sort(), [
      ['build', 3600], ['deep', 3600],
    ]);
    assert.equal(r.items.reduce((n, i) => n + i.seconds, 0), r.totalSeconds);
  });

  test('buckets untagged time rather than dropping it', () => {
    addEntry('alpha', '2026-03-10', 9, 10);
    const r = summarize({ from: '2026-03-10', to: '2026-03-10', groupBy: 'tag' });
    assert.deepEqual(r.items, [{ key: '(untagged)', seconds: 3600, entries: 1, label: '(untagged)' }]);
  });

  test('counts a running entry up to now', () => {
    const p = ensureProject('alpha');
    const startedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    handle()
      .prepare('INSERT INTO entries (project_id, tags, started_at) VALUES (?,?,?)')
      .run(p.id, '', startedAt);

    const today = dayKey(new Date());
    const secs = summarize({ from: today, to: today }).totalSeconds;
    // Allow slack for a run that straddles local midnight.
    assert.ok(secs > 0 && secs <= 90 * 60 + 5, `got ${secs}`);
  });
});

describe('timeseries', () => {
  test('zero-fills days with no tracked time', () => {
    addEntry('alpha', '2026-03-10', 9, 10);
    const s = timeseries({ from: '2026-03-08', to: '2026-03-11' });
    assert.deepEqual(s, [
      { day: '2026-03-08', seconds: 0 },
      { day: '2026-03-09', seconds: 0 },
      { day: '2026-03-10', seconds: 3600 },
      { day: '2026-03-11', seconds: 0 },
    ]);
  });
});

describe('parseDuration', () => {
  test('parses hours and minutes in any spacing', () => {
    assert.equal(parseDuration('1h 45m'), 6300);
    assert.equal(parseDuration('1h45m'), 6300);
    assert.equal(parseDuration('45m'), 2700);
    assert.equal(parseDuration('2h'), 7200);
    assert.equal(parseDuration('1.5h'), 5400);
    assert.equal(parseDuration('90m'), 5400);
  });

  test('reads a bare number as minutes', () => {
    assert.equal(parseDuration('90'), 5400);
  });

  test('returns null for junk or non-positive input', () => {
    for (const bad of ['', '   ', 'abc', '0m', '0h 0m', 'h', null, undefined]) {
      assert.equal(parseDuration(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('date helpers', () => {
  test('addDays crosses month and year boundaries', () => {
    assert.equal(addDays('2026-03-31', 1), '2026-04-01');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  });

  test('weekStart is Monday-based and idempotent', () => {
    assert.equal(weekStart('2026-03-15'), '2026-03-09'); // Sunday -> prior Monday
    assert.equal(weekStart('2026-03-09'), '2026-03-09'); // Monday -> itself
    assert.equal(weekStart('2026-03-10'), '2026-03-09');
  });
});

describe('manual entries and start-time edits', () => {
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  test('adds a manual record for time already worked', async () => {
    const r = await call('POST', '/api/entries', {
      project: 'Backfilled Project',
      description: 'yesterday morning',
      tags: 'build',
      startedAt: iso('2026-03-10', 9),
      endedAt: iso('2026-03-10', 11, 30),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.project, 'backfilled-project');
    assert.deepEqual(r.body.tags, ['build']);
    assert.equal(summarize({ from: '2026-03-10', to: '2026-03-10' }).totalSeconds, 2.5 * 3600);
  });

  test('adds a duration entry anchored to a given end time', async () => {
    const endedAt = iso('2026-03-10', 17);
    const r = await call('POST', '/api/entries', {
      project: 'duration-project', description: 'no clock', duration: '1h 45m', endedAt,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.startedAt, iso('2026-03-10', 15, 15));
    assert.equal(r.body.endedAt, endedAt);
    assert.equal(summarize({ from: '2026-03-10', to: '2026-03-10' }).totalSeconds, 6300);
  });

  test('anchors a duration forward from a start time', async () => {
    const r = await call('POST', '/api/entries', {
      project: 'alpha', duration: '30m', startedAt: iso('2026-03-10', 9),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.endedAt, iso('2026-03-10', 9, 30));
  });

  test('rejects an unparseable duration with 400', async () => {
    const r = await call('POST', '/api/entries', {
      project: 'never-created-2', duration: 'soon', endedAt: iso('2026-03-10', 17),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /duration is not valid/);
    const exists = handle().prepare('SELECT 1 FROM projects WHERE slug = ?').get('never-created-2');
    assert.equal(exists, undefined);
  });

  test('rejects a manual record that ends before it starts', async () => {
    const r = await call('POST', '/api/entries', {
      project: 'alpha', startedAt: iso('2026-03-10', 11), endedAt: iso('2026-03-10', 9),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /endedAt must be after startedAt/);
  });

  test('rejects an unparseable date with 400, not 500', async () => {
    const r = await call('POST', '/api/entries', {
      project: 'alpha', startedAt: 'not-a-date', endedAt: iso('2026-03-10', 9),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not a valid date/);
  });

  test('moves a running timer\'s start time earlier', async () => {
    const started = await call('POST', '/api/projects/alpha/start', { description: 'live' });
    const earlier = new Date(Date.now() - 45 * 60 * 1000).toISOString();

    const patched = await call('PATCH', `/api/entries/${started.body.started.id}`, {
      startedAt: earlier,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.running, true);
    assert.equal(patched.body.startedAt, earlier);

    const state = await call('GET', '/api/state');
    const elapsed = (Date.now() - new Date(state.body.running.startedAt)) / 1000;
    assert.ok(elapsed > 44 * 60, `expected ~45m elapsed, got ${Math.round(elapsed / 60)}m`);
  });

  test('a rejected entry does not leave an empty project behind', async () => {
    const r = await call('POST', '/api/entries', {
      project: 'never-created', startedAt: 'garbage', endedAt: iso('2026-03-10', 9),
    });
    assert.equal(r.status, 400);
    const exists = handle().prepare('SELECT 1 FROM projects WHERE slug = ?').get('never-created');
    assert.equal(exists, undefined);
  });

  test('deletes an unused project but guards one with tracked time', async () => {
    await call('POST', '/api/projects', { slug: 'typo-projct' });
    assert.equal((await call('DELETE', '/api/projects/typo-projct')).status, 200);

    await call('POST', '/api/entries', {
      project: 'has-time', startedAt: iso('2026-03-10', 9), endedAt: iso('2026-03-10', 10),
    });
    const guarded = await call('DELETE', '/api/projects/has-time');
    assert.equal(guarded.status, 409);
    assert.match(guarded.body.error, /force=1/);

    const forced = await call('DELETE', '/api/projects/has-time?force=1');
    assert.equal(forced.status, 200);
    assert.equal(forced.body.entriesDeleted, 1);
    assert.equal(handle().prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
  });

  test('refuses to move a running start into the future', async () => {
    const started = await call('POST', '/api/projects/alpha/start', {});
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = await call('PATCH', `/api/entries/${started.body.started.id}`, { startedAt: future });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cannot be in the future/);
  });
});

describe('continuing an entry', () => {
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  /** A stopped entry that ran for `hours`, ending `agoMinutes` ago. */
  const stoppedEntry = async (slug, hours, agoMinutes) => {
    const endedAt = new Date(Date.now() - agoMinutes * 60_000);
    const r = await call('POST', '/api/entries', {
      project: slug,
      startedAt: new Date(endedAt - hours * 3600_000).toISOString(),
      endedAt: endedAt.toISOString(),
    });
    return r.body;
  };

  test('include reopens the entry in place, billing the break', async () => {
    const e = await stoppedEntry('alpha', 1, 30);
    const r = await call('POST', `/api/entries/${e.id}/continue`, { mode: 'include' });

    assert.equal(r.status, 200);
    assert.equal(r.body.continued.running, true);
    assert.equal(r.body.continued.id, e.id);
    // Reopened, not duplicated.
    assert.equal(handle().prepare('SELECT COUNT(*) n FROM entries').get().n, 1);
    // started_at untouched, so the 30m break is now inside the session.
    assert.equal(r.body.continued.startedAt, e.startedAt);
    const secs = summarize({ project: 'alpha' }).totalSeconds;
    assert.ok(Math.abs(secs - 1.5 * 3600) < 5, `expected ~1h30m, got ${secs}s`);
  });

  test('exclude shifts the start forward, preserving tracked time', async () => {
    const e = await stoppedEntry('alpha', 1, 30);
    const r = await call('POST', `/api/entries/${e.id}/continue`, { mode: 'exclude' });

    assert.equal(r.status, 200);
    assert.equal(r.body.continued.running, true);
    assert.ok(new Date(r.body.continued.startedAt) > new Date(e.startedAt));
    const secs = summarize({ project: 'alpha' }).totalSeconds;
    assert.ok(Math.abs(secs - 3600) < 5, `expected the banked ~1h, got ${secs}s`);
  });

  test('stops whatever else was running first', async () => {
    const e = await stoppedEntry('alpha', 1, 30);
    await call('POST', '/api/projects/beta/start', {});

    const r = await call('POST', `/api/entries/${e.id}/continue`, { mode: 'include' });
    assert.equal(r.status, 200);
    assert.equal(r.body.stopped.project, 'beta');

    const state = await call('GET', '/api/state');
    assert.equal(state.body.running.id, e.id);
  });

  test('rejects continuing a timer that is already running', async () => {
    const started = await call('POST', '/api/projects/alpha/start', {});
    const r = await call('POST', `/api/entries/${started.body.started.id}/continue`, {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already running/);
  });

  test('rejects an unknown entry and an unknown mode', async () => {
    assert.equal((await call('POST', '/api/entries/9999/continue', {})).status, 404);

    const e = await stoppedEntry('alpha', 1, 30);
    const bad = await call('POST', `/api/entries/${e.id}/continue`, { mode: 'sideways' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /include.*exclude/);
  });
});

describe('entry status / percent / eta', () => {
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  test('round-trips status, percent and eta for a WIP entry', async () => {
    const created = await call('POST', '/api/entries', {
      project: 'alpha',
      startedAt: iso('2026-03-10', 9),
      endedAt: iso('2026-03-10', 11),
      status: 'WIP',
      percent: 40,
      eta: 'Fri',
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.status, 'WIP');
    assert.equal(created.body.percent, 40);
    assert.equal(created.body.eta, 'Fri');

    const list = await call('GET', '/api/entries?from=2026-03-10&to=2026-03-10');
    const row = list.body.find((e) => e.id === created.body.id);
    assert.equal(row.status, 'WIP');
    assert.equal(row.percent, 40);
    assert.equal(row.eta, 'Fri');
  });

  test('nulls percent and eta when the status is not WIP', async () => {
    const created = await call('POST', '/api/entries', {
      project: 'alpha',
      startedAt: iso('2026-03-10', 9),
      endedAt: iso('2026-03-10', 11),
      status: 'Done',
      percent: 40,
      eta: 'Fri',
    });
    assert.equal(created.body.status, 'Done');
    assert.equal(created.body.percent, null);
    assert.equal(created.body.eta, null);
  });

  test('clamps percent to 0-100 and rounds to an integer', async () => {
    const created = await call('POST', '/api/entries', {
      project: 'alpha',
      startedAt: iso('2026-03-10', 9),
      endedAt: iso('2026-03-10', 11),
      status: 'WIP',
      percent: 150.6,
    });
    assert.equal(created.body.percent, 100);
    assert.equal(created.body.eta, null);
  });

  test('switching a WIP entry to Done clears percent and eta on PATCH', async () => {
    const created = await call('POST', '/api/entries', {
      project: 'alpha',
      startedAt: iso('2026-03-10', 9),
      endedAt: iso('2026-03-10', 11),
      status: 'WIP',
      percent: 60,
      eta: 'tomorrow',
    });
    const patched = await call('PATCH', `/api/entries/${created.body.id}`, {
      status: 'Done',
      percent: null,
      eta: null,
    });
    assert.equal(patched.body.status, 'Done');
    assert.equal(patched.body.percent, null);
    assert.equal(patched.body.eta, null);
  });

  test('reports distinct saved statuses via /api/state', async () => {
    await call('POST', '/api/entries', {
      project: 'alpha', startedAt: iso('2026-03-10', 9), endedAt: iso('2026-03-10', 10),
      status: 'Ready For QA',
    });
    await call('POST', '/api/entries', {
      project: 'alpha', startedAt: iso('2026-03-10', 11), endedAt: iso('2026-03-10', 12),
      status: 'WIP', percent: 10,
    });
    const state = await call('GET', '/api/state');
    assert.deepEqual(state.body.statuses, ['Ready For QA', 'WIP']);
  });

  test('defaults a manual entry with no status to an empty string', async () => {
    const created = await call('POST', '/api/entries', {
      project: 'alpha', startedAt: iso('2026-03-10', 9), endedAt: iso('2026-03-10', 10),
    });
    assert.equal(created.body.status, '');
    assert.equal(created.body.percent, null);
    assert.equal(created.body.eta, null);
  });
});

describe('toCSV', () => {
  test('escapes quotes, commas and newlines', () => {
    const out = toCSV([{ a: 'x,y', b: 'say "hi"' }], [
      { header: 'a', value: (r) => r.a },
      { header: 'b', value: (r) => r.b },
    ]);
    assert.equal(out, 'a,b\n"x,y","say ""hi"""\n');
  });
});
