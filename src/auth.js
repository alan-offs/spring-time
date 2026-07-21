// Google sign-in — optional, and identity only.
//
// When GOOGLE_OAUTH_* is unset every endpoint here reports `enabled: false` and
// the dashboard hides the button, so the CLI, the menu bar app and a plain
// self-hosted install keep working with no identity at all. Signing in does not
// gate any data: `WT_TOKEN` is still the access control for `/api/*`.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handle, HttpError } from './db.js';

// A repo-root .env, read once at import. Real environment variables take
// precedence (that is --env-file's own rule), so a launchd/systemd unit can
// still override the file.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* no .env — configure through the environment instead, or not at all */
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// `spreadsheets` (read + write) lets the server fill in a user's row of the team
// WIP sheet on their behalf. Adding it means existing sessions — signed in before
// this scope existed — must sign in again to grant it; getGoogleAccessToken()
// throws a 401 for them so the client can prompt a reconnect.
const SCOPES = 'openid email profile https://www.googleapis.com/auth/spreadsheets';

const SESSION_COOKIE = 'wt_session';
const STATE_COOKIE = 'wt_oauth';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const STATE_SECONDS = 10 * 60;

// OAuth client credentials never live in the repo — the client id and secret are
// distributed to teammates out of band (a shared `.env`, copied from `.env.example`)
// and loaded at import above. Only the fixed loopback redirect URI is defaulted
// here; with GOOGLE_OAUTH_CLIENT_ID / _SECRET unset, sign-in stays disabled.
const DEFAULT_OAUTH = {
  clientId: '',
  clientSecret: '',
  redirectUri: 'http://127.0.0.1:4321/api/auth/google/callback',
};

// An *unset* variable falls back to the baked-in default; an explicit empty
// string is an intentional override that turns sign-in off (self-host with no
// identity). Both distinctions matter, so check `undefined` rather than `|| ''`.
function envOr(name, fallback) {
  return process.env[name] === undefined ? fallback : process.env[name];
}

function googleConfig() {
  return {
    clientId: envOr('GOOGLE_OAUTH_CLIENT_ID', DEFAULT_OAUTH.clientId),
    clientSecret: envOr('GOOGLE_OAUTH_CLIENT_SECRET', DEFAULT_OAUTH.clientSecret),
    redirectUri: envOr('GOOGLE_OAUTH_REDIRECT_URI', DEFAULT_OAUTH.redirectUri),
  };
}

export function authEnabled() {
  const c = googleConfig();
  return Boolean(c.clientId && c.clientSecret && c.redirectUri);
}

function requireConfig() {
  if (!authEnabled()) {
    throw new HttpError(503, 'google sign-in is not configured on this server');
  }
  return googleConfig();
}

// ----------------------------------------------------------------- cookies --

export function readCookies(req) {
  const jar = new Map();
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      jar.set(name, decodeURIComponent(part.slice(eq + 1).trim()));
    } catch {
      jar.set(name, part.slice(eq + 1).trim());
    }
  }
  return jar;
}

/**
 * SameSite=Lax, not Strict: the OAuth callback is a top-level navigation coming
 * from accounts.google.com, and Strict would withhold the state cookie exactly
 * there — the one request that has to read it.
 */
function setCookie(name, value, maxAge) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`,
  ];
  if (googleConfig().redirectUri.startsWith('https:')) bits.push('Secure');
  return bits.join('; ');
}

const clearCookie = (name) => setCookie(name, '', 0);

// ---------------------------------------------------------------- sessions --

function shapeUser(row) {
  return { name: row.name, email: row.email, picture: row.picture };
}

export function sessionUser(req) {
  const id = readCookies(req).get(SESSION_COOKIE);
  if (!id) return null;
  handle().prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  const row = handle()
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
    .get(id);
  return row ? shapeUser(row) : null;
}

function createSession(userId) {
  const id = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  handle()
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(id, userId, expires);
  return id;
}

export function endSession(req) {
  const id = readCookies(req).get(SESSION_COOKIE);
  if (id) handle().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return clearCookie(SESSION_COOKIE);
}

/** Upsert on the Google subject id — email and name can both change upstream. */
function upsertUser(profile) {
  const db = handle();
  const found = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(profile.sub);
  if (found) {
    db.prepare('UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?')
      .run(profile.email, profile.name, profile.picture, found.id);
    return found.id;
  }
  const info = db
    .prepare('INSERT INTO users (google_sub, email, name, picture) VALUES (?, ?, ?, ?)')
    .run(profile.sub, profile.email, profile.name, profile.picture);
  return info.lastInsertRowid;
}

// ---------------------------------------------------------- google tokens --

/**
 * A little early so a request that starts near the edge doesn't sail past it
 * mid-flight and hit Google with a just-expired token.
 */
const TOKEN_SKEW_MS = 60 * 1000;

/**
 * Persist the tokens from a code exchange or refresh. Google omits refresh_token
 * on a refresh (and sometimes on re-consent), so keep the stored one when it's
 * absent rather than nulling it out.
 */
function storeTokens(userId, payload) {
  const expiry = payload.expires_in
    ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString()
    : null;
  if (payload.refresh_token) {
    handle()
      .prepare('UPDATE users SET access_token = ?, refresh_token = ?, token_expiry = ? WHERE id = ?')
      .run(payload.access_token || null, payload.refresh_token, expiry, userId);
  } else {
    handle()
      .prepare('UPDATE users SET access_token = ?, token_expiry = ? WHERE id = ?')
      .run(payload.access_token || null, expiry, userId);
  }
}

function userRowForSession(req) {
  const id = readCookies(req).get(SESSION_COOKIE);
  if (!id) return null;
  return handle()
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
    .get(id);
}

/**
 * Return a valid Google access token for the signed-in user, refreshing it via
 * the stored refresh_token when it's expired. Throws 401 when there is no usable
 * token — a not-signed-in request, or a session predating the Sheets scope — so
 * the client can send the user back through consent.
 */
export async function getGoogleAccessToken(req) {
  const user = userRowForSession(req);
  if (!user) throw new HttpError(401, 'sign in with Google first');

  const fresh = user.token_expiry && Date.parse(user.token_expiry) - TOKEN_SKEW_MS > Date.now();
  if (user.access_token && fresh) return user.access_token;

  if (!user.refresh_token) {
    throw new HttpError(401, 'reconnect Google to grant Sheets access');
  }

  const { clientId, clientSecret } = requireConfig();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: user.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.access_token) {
    // A revoked or expired refresh token can't be salvaged here — make the user
    // reconnect rather than looping on a token Google won't honour.
    throw new HttpError(401, 'reconnect Google to grant Sheets access');
  }
  storeTokens(user.id, payload);
  return payload.access_token;
}

// ------------------------------------------------------------------- flow --

/**
 * Only same-origin absolute paths may be returned to after sign-in, so the
 * redirect can't be pointed at another site. `//evil.com` is a protocol-relative
 * URL, which is why a leading `/` alone is not enough of a check.
 */
function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)/.test(next) ? next : '/';
}

/** Step 1: hand the browser a consent URL, with CSRF state parked in a cookie. */
export function beginAuth(next) {
  const { clientId, redirectUri } = requireConfig();
  const nonce = randomBytes(16).toString('base64url');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state: nonce,
    // offline + consent so Google returns a refresh_token we can use to keep
    // writing to Sheets after the short-lived access token expires.
    access_type: 'offline',
    prompt: 'consent select_account',
  });
  return {
    url: `${AUTH_ENDPOINT}?${params}`,
    // The nonce is what Google echoes back; the return path rides along in the
    // cookie so it never has to survive a round trip through a query string.
    cookie: setCookie(STATE_COOKIE, `${nonce}:${safeNext(next)}`, STATE_SECONDS),
  };
}

/** Step 2: verify state, trade the code for a profile, open a session. */
export async function completeAuth(req, query) {
  const { clientId, clientSecret, redirectUri } = requireConfig();

  if (query.get('error')) throw new HttpError(400, `google returned ${query.get('error')}`);
  const code = query.get('code');
  if (!code) throw new HttpError(400, 'missing code');

  const stored = readCookies(req).get(STATE_COOKIE) || '';
  const sep = stored.indexOf(':');
  const nonce = sep < 0 ? stored : stored.slice(0, sep);
  const next = sep < 0 ? '/' : safeNext(stored.slice(sep + 1));
  if (!nonce || !sameString(nonce, query.get('state') || '')) {
    throw new HttpError(400, 'sign-in state did not match; please try again');
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HttpError(502, `google token exchange failed: ${payload.error || res.status}`);
  }

  const profile = decodeIdToken(payload.id_token);
  const userId = upsertUser(profile);
  storeTokens(userId, payload);
  return {
    next,
    cookies: [setCookie(SESSION_COOKIE, createSession(userId), SESSION_SECONDS),
              clearCookie(STATE_COOKIE)],
  };
}

function sameString(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The signature is deliberately not verified: this id_token came back on our own
 * TLS connection to Google's token endpoint, which Google documents as
 * sufficient. We never accept an id_token submitted by a client, which is the
 * case that would require checking the JWKS.
 */
function decodeIdToken(idToken) {
  const part = String(idToken || '').split('.')[1];
  if (!part) throw new HttpError(502, 'google response had no id_token');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(502, 'google id_token was not readable');
  }
  if (!claims.sub) throw new HttpError(502, 'google id_token had no subject');
  return {
    sub: String(claims.sub),
    email: String(claims.email || ''),
    name: String(claims.name || claims.email || 'Signed in'),
    picture: String(claims.picture || ''),
  };
}
