import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, handle } from '../src/db.js';
import {
  OT_HEADERS, formatDate, formatTime, formatHours, formatTotal, toOtRows, renderOtHtml, otSubject,
  boardColumnName, renderOtEmail,
} from '../src/teamwork.js';
import { buildRaw, parseAddresses } from '../src/gmail.js';

// Same ordering rule as auth.test.js: env first, server import after.
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
const { createServer } = await import('../src/server.js');

const SITE = 'acme.teamwork.com';
// Local-time dates (not UTC literals) so the suite passes in any timezone.
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

const decodeRaw = (raw) => Buffer.from(raw, 'base64url').toString('utf8');
const bodyOf = (raw) => {
  const [, body] = decodeRaw(raw).split('\r\n\r\n');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
};

// ------------------------------------------------------------- pure helpers --

describe('formatters', () => {
  test('date is dd/mm/yy (as in the real OT mail), time is h:mm:ss AM/PM', () => {
    assert.equal(formatDate(new Date(2026, 10, 12, 7, 27)), '12/11/26');
    assert.equal(formatTime(new Date(2026, 10, 12, 7, 27)), '7:27:00 AM');
    assert.equal(formatTime(new Date(2026, 10, 12, 22, 0)), '10:00:00 PM');
    assert.equal(formatTime(new Date(2026, 10, 13, 0, 0)), '12:00:00 AM');
    assert.equal(formatTime(new Date(2026, 10, 12, 12, 5)), '12:05:00 PM');
  });

  test('hours drop trailing zeros', () => {
    assert.equal(formatHours(120), '2');
    assert.equal(formatHours(25), '0.42');
    assert.equal(formatHours(90), '1.5');
  });

  test('total comes from whole minutes, so it can never print 60m', () => {
    assert.equal(formatTotal(25), '0h 25m');
    assert.equal(formatTotal(119.6), '2h 0m');
    assert.equal(formatTotal(0), '0h 0m');
    assert.equal(formatTotal(61), '1h 1m');
  });
});

describe('toOtRows', () => {
  const included = {
    tasks: { 11: { id: 11, name: 'Fix login', workflowStages: [{ workflowId: 3, stageId: 30 }] } },
    stages: { 30: { id: 30, name: 'Done local' } },
    projects: { 5: { id: 5, name: 'Visibl' } },
  };

  test('one row per timelog, shaped like the Program tab, sorted by start', () => {
    const rows = toOtRows(
      [
        { id: 2, timeLogged: at(2026, 11, 12, 22, 0), minutes: 120, hasStartTime: true, taskId: 11, projectId: 5 },
        { id: 1, timeLogged: at(2026, 11, 12, 7, 27), minutes: 25, hasStartTime: true, taskId: 11, projectId: 5 },
      ],
      included, SITE, '2026-11-12',
    );
    assert.deepEqual(rows.map((r) => r.id), [1, 2]);
    assert.deepEqual(
      [rows[0].date, rows[0].start, rows[0].end, rows[0].hours, rows[0].project, rows[0].link, rows[0].status],
      ['12/11/26', '7:27:00 AM', '7:52:00 AM', '0.42', 'Visibl', `https://${SITE}/app/tasks/11`, 'Done local'],
    );
    assert.equal(rows[0].title, 'Fix login');
    // Crosses midnight: still shows the clock time, as the template's 10 PM → 12 AM row does.
    assert.equal(rows[1].end, '12:00:00 AM');
  });

  test('keeps an early-morning entry the UTC date would have pushed to the day before', () => {
    // The timelog is stored as an instant; what matters is the *local* day.
    const rows = toOtRows([{ id: 1, timeLogged: at(2026, 11, 12, 0, 30), minutes: 30, hasStartTime: true }], {}, SITE, '2026-11-12');
    assert.equal(rows.length, 1);
  });

  test('drops entries from the neighbouring days that the wide query pulled in', () => {
    const rows = toOtRows(
      [
        { id: 1, timeLogged: at(2026, 11, 11, 23, 0), minutes: 60, hasStartTime: true },
        { id: 2, timeLogged: at(2026, 11, 13, 0, 0), minutes: 60, hasStartTime: true },
      ],
      {}, SITE, '2026-11-12',
    );
    assert.deepEqual(rows, []);
  });

  test('an entry with no recorded start time leaves Start/End blank rather than 12:00:00 AM', () => {
    const [row] = toOtRows([{ id: 1, timeLogged: at(2026, 11, 12, 0, 0), minutes: 90, hasStartTime: false }], {}, SITE, '2026-11-12');
    assert.equal(row.start, '');
    assert.equal(row.end, '');
    assert.equal(row.hours, '1.5');
  });

  test('an entry with no task falls back to its description; unknown column is blank', () => {
    const [row] = toOtRows(
      [{ id: 1, timeLogged: at(2026, 11, 12, 9), minutes: 30, hasStartTime: true, description: ' Standup ' }],
      {}, SITE, '2026-11-12',
    );
    assert.equal(row.link, 'Standup');
    assert.equal(row.status, '');
  });

  test("only the owner's timelogs survive, even if the query let a teammate's through", () => {
    const rows = toOtRows(
      [
        { id: 1, userId: 99, timeLogged: at(2026, 11, 12, 9), minutes: 30, hasStartTime: true },
        { id: 2, userId: 42, timeLogged: at(2026, 11, 12, 10), minutes: 60, hasStartTime: true },
      ],
      {}, SITE, '2026-11-12', 99,
    );
    assert.deepEqual(rows.map((r) => r.id), [1]);
  });

  test('board column = the names of the task\'s workflow stages', () => {
    const stages = { 7: { id: 7, name: 'Review' }, 8: { id: 8, name: 'QA' } };
    const one = { workflowStages: [{ workflowId: 1, stageId: 7 }] };
    assert.equal(boardColumnName(one, { stages }), 'Review');
    // On two boards: both names, each once.
    const two = { workflowStages: [{ workflowId: 1, stageId: 7 }, { workflowId: 2, stageId: 8 }, { workflowId: 3, stageId: 7 }] };
    assert.equal(boardColumnName(two, { stages }), 'Review, QA');
    // Not on a board, an unknown stage, or no task at all: blank, never a throw.
    assert.equal(boardColumnName({ workflowStages: [] }, { stages }), '');
    assert.equal(boardColumnName({ workflowStages: [{ stageId: 99 }] }, { stages }), '');
    assert.equal(boardColumnName(undefined, {}), '');
  });
});

describe('renderOtHtml', () => {
  const rows = [{
    id: 1, minutes: 25, date: '12/11/26', start: '7:27:00 AM', end: '7:52:00 AM', hours: '0.42',
    project: 'A & B', link: `https://${SITE}/app/tasks/11`, status: 'Done local',
  }];

  test('header text is the template verbatim, with a total in column D', () => {
    const html = renderOtHtml(rows);
    for (const h of OT_HEADERS) assert.ok(html.includes(`>${h.replace("'", '&#39;')}</th>`), h);
    assert.match(html, /<td[^>]*background:#f0f0f0[^>]*>0h 25m<\/td>/);
    assert.equal((html.match(/<th /g) || []).length, 7);
    assert.equal((html.match(/<tr>/g) || []).length, 3); // header + 1 row + total
  });

  test('escapes Teamwork-supplied text and only links https URLs', () => {
    const html = renderOtHtml([{ ...rows[0], project: '<script>x</script>', link: 'javascript:alert(1)', status: '"><img>' }]);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img>'));
    assert.ok(!html.includes('href="javascript'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(renderOtHtml(rows).includes(`href="https://${SITE}/app/tasks/11"`));
  });
});

describe('task link and status cells', () => {
  const row = {
    id: 1, minutes: 25, date: '12/11/26', start: '7:27:00 AM', end: '7:52:00 AM', hours: '0.42',
    project: 'Visibl', link: `https://${SITE}/app/tasks/11`, title: 'Create new email template', status: 'Done local',
  };

  test('the task column shows the task title, linked to the task; no title falls back to the URL', () => {
    const html = renderOtHtml([row]);
    assert.ok(html.includes(`<a href="https://${SITE}/app/tasks/11" style="color:#1155cc;text-decoration:none;">Create new email template</a>`));
    assert.ok(renderOtHtml([{ ...row, title: '' }]).includes(`>https://${SITE}/app/tasks/11</a>`));
  });

  test('a multi-line status keeps its line breaks and stays escaped', () => {
    const html = renderOtHtml([{ ...row, status: 'Done local\n- #25-28: Done\n- #29: <need> confirm' }]);
    assert.ok(html.includes('Done local<br>- #25-28: Done<br>- #29: &lt;need&gt; confirm'));
  });
});

describe('renderOtEmail', () => {
  const rows = [{
    id: 1, minutes: 25, date: '12/11/26', start: '7:27:00 AM', end: '7:52:00 AM', hours: '0.42',
    project: 'Visibl', link: 'free text', title: '', status: 'Done',
  }];

  test('greeting, intro, table, closing, signature — in that order', () => {
    const html = renderOtEmail({
      greeting: 'Dear chị Rose,', intro: 'Em xin phép gửi logs thời gian OT ạ:', rows,
      closing: 'Thanks & Regards', signature: '<div>Alan<br><b>Dev</b></div>',
    });
    const at = (needle) => html.indexOf(needle);
    const order = ['Dear chị Rose,', 'Em xin phép gửi logs thời gian OT ạ:', '<table', '0h 25m', 'Thanks &amp; Regards', '<b>Dev</b>'].map(at);
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(html, /<div class="gmail_signature"[^>]*><div>Alan<br><b>Dev<\/b><\/div><\/div>$/);
  });

  test('wording is escaped, the signature is the sender\'s own HTML, and empty parts vanish', () => {
    const html = renderOtEmail({ greeting: '<i>hi</i>', intro: '', rows, closing: '  ', signature: '' });
    assert.ok(html.includes('&lt;i&gt;hi&lt;/i&gt;'));
    assert.ok(!html.includes('gmail_signature'));
    assert.equal((html.match(/<div>/g) || []).length, 1); // only the greeting paragraph
  });
});

describe('otSubject', () => {
  test('fills {name} and {date}, and cannot be split across lines', () => {
    assert.equal(otSubject('OT request - {name} - {date}', 'Ada', '2026-11-12'), 'OT request - Ada - 2026-11-12');
    assert.equal(otSubject('x\r\nBcc: evil@x.com', 'Ada', '2026-11-12'), 'x Bcc: evil@x.com');
    assert.equal(otSubject('', 'Ada', '2026-11-12'), 'OT request - Ada - 2026-11-12');
  });
});

describe('gmail.buildRaw', () => {
  test('builds To/Cc/Subject headers and a base64 HTML body, base64url-encoded', () => {
    const raw = buildRaw({ to: 'boss@x.com, hr@x.com', cc: ['me@x.com'], subject: 'OT', html: '<b>hi ✓</b>' });
    assert.match(raw, /^[A-Za-z0-9_-]+$/);
    const text = decodeRaw(raw);
    assert.match(text, /^To: boss@x\.com, hr@x\.com\r\nCc: me@x\.com\r\nSubject: OT\r\n/);
    assert.match(text, /Content-Type: text\/html; charset=UTF-8/);
    assert.equal(bodyOf(raw), '<b>hi ✓</b>');
  });

  test('omits Cc when empty and encodes a non-ASCII subject (RFC 2047)', () => {
    const text = decodeRaw(buildRaw({ to: 'a@x.com', subject: 'Báo cáo OT', html: 'x' }));
    assert.ok(!text.includes('Cc:'));
    const encoded = text.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'Báo cáo OT');
  });

  test('refuses header injection and a missing recipient', () => {
    assert.throws(() => buildRaw({ to: 'a@x.com\r\nBcc: evil@x.com', subject: 's', html: 'x' }), /not a valid email/);
    assert.throws(() => buildRaw({ to: '', subject: 's', html: 'x' }), /recipient/);
    assert.deepEqual(parseAddresses('a@x.com; b@y.org  c@z.io', 'to'), ['a@x.com', 'b@y.org', 'c@z.io']);
  });
});

// ------------------------------------------------------------------- HTTP --

let server;
let base;
let realFetch;
let calls;
let gmailReply;
let stageLookupFails;
let signatureReply;

before(async () => {
  const dbFile = join(tmpdir(), `worktime-ot-test-${process.pid}-${Date.now()}.db`);
  open(dbFile);
  server = createServer({ dbFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (u.startsWith(`https://${SITE}/projects/api/v3/`)) {
      calls.push({ url: u, init });
      if (u.includes('/me.json')) return json({ person: { id: 99 } });
      if (u.includes('/tasks.json')) {
        if (stageLookupFails) return json({ MESSAGE: 'boom' }, 500);
        return json({ tasks: [{ id: 11, workflowStages: [{ workflowId: 3, stageId: 30 }] }] });
      }
      if (u.includes('/workflows/3/stages.json')) return json({ stages: [{ id: 30, name: 'Done local' }] });
      return json({
        timelogs: [
          { id: 1, userId: 99, timeLogged: at(2026, 11, 12, 7, 27), minutes: 25, hasStartTime: true, taskId: 11, projectId: 5 },
          // A teammate's entry the server-side filter let through — must never be mailed.
          { id: 3, userId: 42, timeLogged: at(2026, 11, 12, 8, 0), minutes: 45, hasStartTime: true, taskId: 11, projectId: 5 },
          // Pulled in by the wide window but belongs to the next day — must not be mailed.
          { id: 2, userId: 99, timeLogged: at(2026, 11, 13, 9, 0), minutes: 60, hasStartTime: true, taskId: 11, projectId: 5 },
        ],
        included: { tasks: { 11: { id: 11 } }, projects: { 5: { id: 5, name: 'Visibl' } } },
        meta: { page: { hasMore: false } },
      });
    }
    if (u.startsWith('https://gmail.googleapis.com/')) {
      calls.push({ url: u, init });
      if (u.endsWith('/settings/sendAs')) return signatureReply();
      return gmailReply();
    }
    return realFetch(url, init);
  };
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
});

beforeEach(() => {
  handle().exec("DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;");
  process.env.TEAMWORK_SITE = SITE;
  process.env.TEAMWORK_API_TOKEN = 'tw-token';
  calls = [];
  stageLookupFails = false;
  signatureReply = () => new Response(JSON.stringify({
    sendAs: [
      { sendAsEmail: 'alias@example.com', isDefault: false, signature: '<i>not me</i>' },
      { sendAsEmail: 'ada@example.com', isDefault: true, isPrimary: true, signature: '<div>Ada<br>Analytical Engines</div>' },
    ],
  }), { status: 200 });
  gmailReply = () => new Response(JSON.stringify({ id: 'd1', message: { id: 'm1' } }), { status: 200 });
});

/** A signed-in user holding a still-valid Google token, bypassing the OAuth dance. */
function signedIn({ withToken = true } = {}) {
  const { lastInsertRowid } = handle()
    .prepare('INSERT INTO users (google_sub, email, name, access_token, token_expiry) VALUES (?, ?, ?, ?, ?)')
    .run('sub-1', 'ada@example.com', 'Ada Lovelace', withToken ? 'g-access' : null, new Date(Date.now() + 3_600_000).toISOString());
  handle()
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run('sess-1', lastInsertRowid, new Date(Date.now() + 3_600_000).toISOString());
  return { cookie: 'wt_session=sess-1' };
}

const api = (path, { method = 'GET', body, headers } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('/api/ot/settings', () => {
  test('defaults to draft mode, then round-trips and normalizes what is saved', async () => {
    assert.deepEqual(await (await api('/api/ot/settings')).json(), {
      to: '', cc: '', mode: 'draft', subject: 'OT request - {name} - {date}',
      greeting: 'Dear all,', intro: 'Em xin phép gửi logs thời gian OT ạ:', closing: 'Thanks & Regards',
    });

    const put = await api('/api/ot/settings', {
      method: 'PUT', body: { to: 'boss@x.com;hr@x.com', cc: 'me@x.com', mode: 'send' },
    });
    assert.equal(put.status, 200);
    const saved = await (await api('/api/ot/settings')).json();
    assert.equal(saved.to, 'boss@x.com, hr@x.com');
    assert.equal(saved.cc, 'me@x.com');
    assert.equal(saved.mode, 'send');
  });

  test('wording can be changed or emptied, and is length-limited', async () => {
    await api('/api/ot/settings', { method: 'PUT', body: { greeting: 'Dear chị Rose,', closing: '' } });
    const saved = await (await api('/api/ot/settings')).json();
    assert.equal(saved.greeting, 'Dear chị Rose,');
    assert.equal(saved.closing, '');
    assert.equal(saved.intro, 'Em xin phép gửi logs thời gian OT ạ:'); // untouched
    const long = await api('/api/ot/settings', { method: 'PUT', body: { intro: 'x'.repeat(501) } });
    assert.equal(long.status, 400);
  });

  test('rejects a bad address or mode, saving nothing', async () => {
    const bad = await api('/api/ot/settings', { method: 'PUT', body: { to: 'not-an-email' } });
    assert.equal(bad.status, 400);
    const badMode = await api('/api/ot/settings', { method: 'PUT', body: { mode: 'yolo' } });
    assert.equal(badMode.status, 400);
    assert.equal((await (await api('/api/ot/settings')).json()).to, '');
  });
});

describe('GET /api/ot/preview', () => {
  test('returns only that local day, asks Teamwork for a day either side, and authenticates as Basic', async () => {
    const res = await api('/api/ot/preview?date=2026-11-12');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.rows.map((r) => r.id), [1]);
    assert.equal(data.total, '0h 25m');
    assert.match(data.html, /<table/);

    const timeCall = calls.find((c) => c.url.includes('/time.json'));
    const q = new URL(timeCall.url).searchParams;
    assert.equal(q.get('startDate'), '2026-11-11');
    assert.equal(q.get('endDate'), '2026-11-13');
    assert.equal(q.get('assignedToUserIds'), '99');
    assert.equal(timeCall.init.headers.authorization, `Basic ${Buffer.from('tw-token:x').toString('base64')}`);
  });

  test('status column is the task\'s workflow stage, looked up only for tasks being mailed', async () => {
    const data = await (await api('/api/ot/preview?date=2026-11-12')).json();
    assert.equal(data.rows[0].status, 'Done local');
    const tasksCall = calls.find((c) => c.url.includes('/tasks.json'));
    const q = new URL(tasksCall.url).searchParams;
    assert.equal(q.get('ids'), '11');
    assert.equal(q.get('includeCompletedTasks'), 'true');
  });

  test('if the stage lookup fails the preview still works, with a blank status', async () => {
    stageLookupFails = true;
    const res = await api('/api/ot/preview?date=2026-11-12');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).rows[0].status, '');
  });

  test('503 with a pointer to .env when Teamwork is not configured', async () => {
    delete process.env.TEAMWORK_API_TOKEN;
    const res = await api('/api/ot/preview?date=2026-11-12');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /TEAMWORK_API_TOKEN/);
  });

  test('400 on a malformed date', async () => {
    assert.equal((await api('/api/ot/preview?date=12/11/2026')).status, 400);
  });
});

describe('POST /api/ot/send', () => {
  // Creating/sending calls only — the signature lookup is a read and is checked on its own.
  const gmailCalls = () => calls.filter((c) => c.url.startsWith('https://gmail.googleapis.com/') && !c.url.includes('/settings/'));

  test('draft mode creates a draft with the table, to and cc — and does not send', async () => {
    const { cookie } = signedIn();
    const res = await api('/api/ot/send', {
      method: 'POST', headers: { cookie },
      body: { date: '2026-11-12', to: 'boss@x.com', cc: 'me@x.com', mode: 'draft', statuses: { 1: 'Done' } },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.mode, 'draft');
    assert.equal(data.entries, 1);
    assert.equal(data.url, 'https://mail.google.com/mail/?authuser=ada%40example.com#drafts');

    assert.equal(gmailCalls().length, 1);
    const [call] = gmailCalls();
    assert.equal(call.url, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    assert.equal(call.init.headers.authorization, 'Bearer g-access');
    const raw = JSON.parse(call.init.body).message.raw;
    const text = decodeRaw(raw);
    assert.match(text, /To: boss@x\.com\r\nCc: me@x\.com\r\nSubject: OT request - Ada Lovelace - 2026-11-12/);
    const html = bodyOf(raw);
    assert.match(html, /Visibl/);
    assert.match(html, /Done<\/td>/); // the dashboard's status override wins over the board column
    assert.ok(!html.includes('Done local'));

    // The whole mail: wording, then the table, then the closing and the sender's
    // default signature (not the alias's).
    const order = ['Dear all,', 'Em xin phép gửi logs thời gian OT ạ:', '<table', 'Thanks &amp; Regards', 'Analytical Engines'].map((n) => html.indexOf(n));
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(!html.includes('not me'));
    assert.equal(data.signature, true);
    assert.ok(calls.some((c) => c.url === 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'));
  });

  test('send mode (from saved settings) hits messages/send, never drafts', async () => {
    const { cookie } = signedIn();
    await api('/api/ot/settings', { method: 'PUT', body: { to: 'boss@x.com', mode: 'send' } });
    gmailReply = () => new Response(JSON.stringify({ id: 'sent1' }), { status: 200 });

    const res = await api('/api/ot/send', { method: 'POST', headers: { cookie }, body: { date: '2026-11-12' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mode, 'send');
    assert.deepEqual(gmailCalls().map((c) => c.url), ['https://gmail.googleapis.com/gmail/v1/users/me/messages/send']);
  });

  test('a day with no entries is a 409 and creates nothing', async () => {
    const { cookie } = signedIn();
    const res = await api('/api/ot/send', {
      method: 'POST', headers: { cookie }, body: { date: '2026-11-20', to: 'boss@x.com' },
    });
    assert.equal(res.status, 409);
    assert.equal(gmailCalls().length, 0);
  });

  test('no recipient configured is a 400; not signed in is a 401', async () => {
    const { cookie } = signedIn();
    assert.equal((await api('/api/ot/send', { method: 'POST', headers: { cookie }, body: {} })).status, 400);
    assert.equal((await api('/api/ot/send', { method: 'POST', body: { to: 'boss@x.com' } })).status, 401);
  });

  test('a token that lacks the Gmail scope comes back as 401 "sign in again", not 403', async () => {
    const { cookie } = signedIn();
    gmailReply = () => new Response(JSON.stringify({
      error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] },
    }), { status: 403 });

    const res = await api('/api/ot/send', {
      method: 'POST', headers: { cookie }, body: { date: '2026-11-12', to: 'boss@x.com' },
    });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /sign in again/);
  });

  test('other Gmail 403s (e.g. API not enabled) stay 403 with Google\'s message', async () => {
    const { cookie } = signedIn();
    gmailReply = () => new Response(JSON.stringify({
      error: { code: 403, message: 'Gmail API has not been used in project 1 before.', errors: [{ reason: 'accessNotConfigured' }] },
    }), { status: 403 });

    const res = await api('/api/ot/send', {
      method: 'POST', headers: { cookie }, body: { date: '2026-11-12', to: 'boss@x.com' },
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /not been used/);
  });

  test('a second send while one is in flight is refused, so the mail cannot go out twice', async () => {
    const { cookie } = signedIn();
    let release;
    const gate = new Promise((r) => { release = r; });
    gmailReply = async () => {
      await gate;
      return new Response(JSON.stringify({ id: 'd1', message: { id: 'm1' } }), { status: 200 });
    };
    const body = { date: '2026-11-12', to: 'boss@x.com' };

    const first = api('/api/ot/send', { method: 'POST', headers: { cookie }, body });
    while (gmailCalls().length === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await api('/api/ot/send', { method: 'POST', headers: { cookie }, body });
    assert.equal(second.status, 409);

    release();
    assert.equal((await first).status, 200);
    assert.equal(gmailCalls().length, 1);
  });

  test('saved wording and a multi-line status reach the mail', async () => {
    const { cookie } = signedIn();
    await api('/api/ot/settings', { method: 'PUT', body: { greeting: 'Dear chị Rose,', closing: 'Thanks & Regards' } });
    const res = await api('/api/ot/send', {
      method: 'POST', headers: { cookie },
      body: { date: '2026-11-12', to: 'boss@x.com', statuses: { 1: 'Done local\n- #25-28: Done\n- #29: need confirm' } },
    });
    assert.equal(res.status, 200);
    const html = bodyOf(JSON.parse(gmailCalls()[0].init.body).message.raw);
    assert.ok(html.startsWith('<div>Dear chị Rose,</div>'));
    assert.ok(html.includes('Done local<br>- #25-28: Done<br>- #29: need confirm'));
  });

  test('no signature set in Gmail: the mail still goes, and the response says so', async () => {
    const { cookie } = signedIn();
    signatureReply = () => new Response(JSON.stringify({ sendAs: [{ sendAsEmail: 'ada@example.com', isPrimary: true, signature: '' }] }), { status: 200 });
    const res = await api('/api/ot/send', { method: 'POST', headers: { cookie }, body: { date: '2026-11-12', to: 'boss@x.com' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).signature, false);
    assert.ok(!bodyOf(JSON.parse(gmailCalls()[0].init.body).message.raw).includes('gmail_signature'));
  });

  test('a token without the settings scope is a 401 "sign in again" and nothing is created', async () => {
    const { cookie } = signedIn();
    signatureReply = () => new Response(JSON.stringify({
      error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] },
    }), { status: 403 });
    const res = await api('/api/ot/send', { method: 'POST', headers: { cookie }, body: { date: '2026-11-12', to: 'boss@x.com' } });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /sign in again/);
    assert.equal(gmailCalls().length, 0);
  });
});
