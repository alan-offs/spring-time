import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, handle } from '../src/db.js';

// src/auth.js reads GOOGLE_OAUTH_* at import, and process.loadEnvFile() leaves
// real environment variables alone — so setting them here beats any .env the
// developer running the suite happens to have. The import must come after.
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://127.0.0.1:4321/api/auth/google/callback';
const { createServer } = await import('../src/server.js');

const PROFILE = {
  sub: '11223344',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  picture: 'https://lh3.example.com/ada.jpg',
};

/** A structurally valid id_token; only the payload segment is ever read. */
function idToken(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
}

let server;
let base;
let realFetch;
let tokenRequests;

before(async () => {
  const dbFile = join(tmpdir(), `worktime-auth-test-${process.pid}-${Date.now()}.db`);
  open(dbFile);
  server = createServer({ dbFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Stand in for Google's token endpoint; everything else (our own server)
  // still goes over the wire.
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      tokenRequests.push(new URLSearchParams(init.body.toString()));
      return new Response(JSON.stringify({ id_token: idToken(PROFILE) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, init);
  };
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
});

beforeEach(() => {
  handle().exec('DELETE FROM sessions; DELETE FROM users;');
  tokenRequests = [];
});

const get = (path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers });
const cookieValue = (res, name) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '';
const jar = (raw) => raw.split(';')[0];

/** Drive the whole flow and hand back the session cookie. */
async function signIn(next = '/') {
  const start = await get(`/api/auth/google?next=${encodeURIComponent(next)}`);
  const stateCookie = cookieValue(start, 'wt_oauth');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await get(`/api/auth/google/callback?code=abc123&state=${state}`, {
    cookie: jar(stateCookie),
  });
  return { start, done, session: jar(cookieValue(done, 'wt_session')) };
}

describe('GET /api/auth/google', () => {
  test('redirects to the consent screen and parks CSRF state in a cookie', async () => {
    const res = await get('/api/auth/google?next=/p/acme');
    assert.equal(res.status, 302);

    const url = new URL(res.headers.get('location'));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), 'test-client-id');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(
      url.searchParams.get('scope'),
      'openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.settings.basic',
    );
    // Offline access so we get a refresh_token for later Sheets writes.
    assert.equal(url.searchParams.get('access_type'), 'offline');

    const cookie = cookieValue(res, 'wt_oauth');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    // The state Google echoes back must be the nonce we stored, and the return
    // path rides along in the cookie rather than through Google.
    assert.ok(cookie.includes(`${url.searchParams.get('state')}%3A%2Fp%2Facme`));
  });

  test('refuses to take a redirect off-site', async () => {
    // Protocol-relative: starts with "/" but leaves the origin.
    const res = await get('/api/auth/google?next=' + encodeURIComponent('//evil.example.com'));
    assert.ok(cookieValue(res, 'wt_oauth').endsWith('%3A%2F; Path=/; HttpOnly; SameSite=Lax; Max-Age=600'));
  });

  test('is not secure-flagged when the redirect URI is plain http', async () => {
    const res = await get('/api/auth/google');
    assert.doesNotMatch(cookieValue(res, 'wt_oauth'), /Secure/);
  });
});

describe('GET /api/auth/google/callback', () => {
  test('exchanges the code, opens a session and returns to the start page', async () => {
    const { done, session } = await signIn('/p/acme');

    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/p/acme');
    assert.match(cookieValue(done, 'wt_session'), /HttpOnly/);
    assert.ok(session.startsWith('wt_session='));

    const sent = tokenRequests[0];
    assert.equal(sent.get('code'), 'abc123');
    assert.equal(sent.get('client_secret'), 'test-client-secret');
    assert.equal(sent.get('grant_type'), 'authorization_code');

    const me = await (await get('/api/auth/me', { cookie: session })).json();
    assert.deepEqual(me, {
      enabled: true,
      user: { name: 'Ada Lovelace', email: 'ada@example.com', picture: PROFILE.picture },
    });
  });

  test('rejects a state that does not match the cookie', async () => {
    const start = await get('/api/auth/google');
    const res = await get('/api/auth/google/callback?code=abc&state=forged', {
      cookie: jar(cookieValue(start, 'wt_oauth')),
    });
    // A browser mid-navigation gets a message in the app, not a JSON error.
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/\?auth_error=/);
    assert.equal(cookieValue(res, 'wt_session'), '');
    assert.equal(tokenRequests.length, 0);
  });

  test('rejects a callback with no state cookie at all', async () => {
    const res = await get('/api/auth/google/callback?code=abc&state=whatever');
    assert.match(res.headers.get('location'), /^\/\?auth_error=/);
    assert.equal(tokenRequests.length, 0);
  });

  test('signing in twice updates the profile instead of duplicating the user', async () => {
    await signIn();
    PROFILE.name = 'Ada L.';
    const { session } = await signIn();
    PROFILE.name = 'Ada Lovelace';

    assert.equal(handle().prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    const me = await (await get('/api/auth/me', { cookie: session })).json();
    assert.equal(me.user.name, 'Ada L.');
  });
});

describe('GET /api/auth/me', () => {
  test('reports no user when the caller has no session', async () => {
    const res = await get('/api/auth/me');
    assert.deepEqual(await res.json(), { enabled: true, user: null });
  });

  test('reports disabled when the server has no client configured', async () => {
    // An explicit empty string turns the baked-in default client off; a plain
    // `delete` would fall back to it and stay enabled.
    const saved = process.env.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_ID = '';
    try {
      const res = await get('/api/auth/me');
      assert.deepEqual(await res.json(), { enabled: false, user: null });
      // And starting a flow is a clean 503, not a crash.
      assert.equal((await get('/api/auth/google')).status, 503);
    } finally {
      process.env.GOOGLE_OAUTH_CLIENT_ID = saved;
    }
  });

  test('ignores an expired session', async () => {
    const { session } = await signIn();
    handle().prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z');

    const me = await (await get('/api/auth/me', { cookie: session })).json();
    assert.equal(me.user, null);
    // The sweep is what removed it, so the row is gone rather than lingering.
    assert.equal(handle().prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  });
});

describe('POST /api/auth/logout', () => {
  test('drops the session server-side and clears the cookie', async () => {
    const { session } = await signIn();

    const res = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: session },
    });
    assert.equal(res.status, 200);
    assert.match(cookieValue(res, 'wt_session'), /Max-Age=0/);
    assert.equal(handle().prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);

    // Replaying the old cookie must not bring the session back.
    const me = await (await get('/api/auth/me', { cookie: session })).json();
    assert.equal(me.user, null);
  });
});

describe('WT_TOKEN gating', () => {
  test('covers the API but exempts the OAuth leg, which cannot carry a header', async () => {
    // createServer keeps the token in a closure, so exercising the guarded path
    // means a second server of its own.
    const withToken = createServer({
      dbFile: join(tmpdir(), `worktime-auth-token-${process.pid}-${Date.now()}.db`),
      token: 'sekret',
    });
    await new Promise((r) => withToken.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${withToken.address().port}`;
    try {
      assert.equal((await fetch(`${at}/api/state`)).status, 401);
      assert.equal((await fetch(`${at}/api/auth/me`)).status, 200);
      const res = await fetch(`${at}/api/auth/google`, { redirect: 'manual' });
      assert.equal(res.status, 302);
    } finally {
      withToken.close();
    }
  });
});
