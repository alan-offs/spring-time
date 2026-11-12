// Gmail API client for the "Log OT" feature: build a message, then either park it
// as a draft or send it. Zero dependencies — global `fetch`, like sheets.js — and,
// like sheets.js, it only ever receives an already-valid access token.
import { HttpError } from './db.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// --------------------------------------------------------------- pure bits --

// Deliberately loose: Gmail does the real validation. This only has to be
// something a header can carry, and must never admit CR/LF (header injection).
const ADDRESS = /^[^\s<>,;"'()[\]\\]+@[^\s<>,;"'()[\]\\]+\.[^\s<>,;"'()[\]\\]+$/;

/** Split a user-typed "a@x.com, b@y.com" list into addresses; throws 400 on a bad one. */
export function parseAddresses(input, field) {
  const list = (Array.isArray(input) ? input : String(input || '').split(/[,;\s]+/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  for (const a of list) {
    if (!ADDRESS.test(a)) throw new HttpError(400, `${field}: "${a.slice(0, 80)}" is not a valid email address`);
  }
  return list;
}

/** RFC 2047 encoded-word for any non-ASCII subject; ASCII passes through untouched. */
function encodeHeader(text) {
  const clean = String(text).replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** base64 wrapped at 76 columns, as MIME requires of a transfer-encoded body. */
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

/**
 * A complete RFC 2822 HTML message, base64url-encoded the way the Gmail API wants
 * it in `raw`. `From` is left out on purpose — Gmail fills in the authenticated user.
 */
export function buildRaw({ to, cc = [], subject, html }) {
  const toList = parseAddresses(to, 'to');
  const ccList = parseAddresses(cc, 'cc');
  if (toList.length === 0) throw new HttpError(400, 'at least one recipient (to) is required');

  const message = [
    `To: ${toList.join(', ')}`,
    ...(ccList.length ? [`Cc: ${ccList.join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(String(html), 'utf8').toString('base64')),
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

// --------------------------------------------------------------- API calls --

async function call(token, path, body) {
  const res = await fetch(`${GMAIL_API}${path}`, {
    // No body = a read (the settings endpoints); a body = a create/send.
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (res.ok) return payload;

  const detail = payload?.error?.message || res.status;
  const reasons = (payload?.error?.errors || []).map((e) => e.reason).join(' ');
  if (res.status === 401 || (res.status === 403 && /insufficient/i.test(`${reasons} ${detail}`))) {
    // Unlike Sheets, a pre-Gmail session still holds a perfectly valid token — it
    // just lacks the scope. Surface it as 401 so the dashboard offers sign-in again
    // (a 403 would read as "forbidden", not "reconnect").
    throw new HttpError(401, 'sign in again to grant Gmail access');
  }
  if (res.status === 403) throw new HttpError(403, `Gmail refused the request: ${detail}`);
  throw new HttpError(502, `Gmail error: ${detail}`);
}

/**
 * The sender's own Gmail signature as HTML ('' when none is set). The API never adds
 * it to messages it creates — only the Gmail web composer does — so a draft built
 * here has to carry it explicitly. Prefers the default send-as identity, then the
 * primary one, then the address we signed in with. Needs the `gmail.settings.basic`
 * scope; without it Gmail answers 403, which call() turns into "sign in again".
 */
export async function getSignature(token, email) {
  const { sendAs = [] } = await call(token, '/settings/sendAs');
  const me = String(email || '').toLowerCase();
  const mine = sendAs.find((a) => a.isDefault)
    || sendAs.find((a) => a.isPrimary)
    || sendAs.find((a) => String(a.sendAsEmail).toLowerCase() === me);
  return String(mine?.signature || '').trim();
}

// `/u/0/` would open whichever Google account is first in the browser; `authuser`
// takes the address, so the link lands in the mailbox the mail was made in.
const mailbox = (email, label) =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(email || '')}#${label}`;

/** Park the message in Drafts. Resolves `{ id, url }`, where `url` opens the Drafts folder. */
export async function createDraft(token, raw, email) {
  const draft = await call(token, '/drafts', { message: { raw } });
  return { id: draft.id, url: mailbox(email, 'drafts') };
}

/** Send the message now. Resolves `{ id, url }` pointing at the Sent folder. */
export async function sendMessage(token, raw, email) {
  const sent = await call(token, '/messages/send', { raw });
  return { id: sent.id, url: mailbox(email, 'sent') };
}
