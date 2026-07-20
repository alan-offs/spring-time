import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, HttpError } from './db.js';
import { routes } from './api.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createServer({ dbFile, token }) {
  open(dbFile);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      if (path.startsWith('/api/')) {
        if (token && !authorized(req, url, token)) {
          return send(res, 401, { error: 'unauthorized' });
        }
        return await handleApi(req, res, url, path);
      }
      // Every non-API path is the app shell; the client reads the project
      // slug straight off the URL, so /p/<anything> works without a route table.
      return await serveStatic(res, path);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      send(res, status, { error: err.message });
    }
  });
}

function authorized(req, url, token) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  return bearer === token || url.searchParams.get('token') === token;
}

async function handleApi(req, res, url, path) {
  for (const [method, pattern, handler] of routes) {
    const m = path.match(pattern);
    if (!m) continue;
    if (method !== req.method) continue;

    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJSON(req) : {};
    const result = await handler(m, { body, query: url.searchParams, req });

    if (result && result.__raw) {
      res.writeHead(result.status, result.headers);
      return res.end(result.body);
    }
    return send(res, 200, result ?? { ok: true });
  }
  send(res, 404, { error: `no route for ${req.method} ${path}` });
}

async function readJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'payload too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

async function serveStatic(res, path) {
  const candidates = [];
  if (path !== '/') {
    // normalize() collapses any ../ before it can escape PUBLIC_DIR.
    candidates.push(join(PUBLIC_DIR, normalize(path).replace(/^(\.\.[/\\])+/, '')));
  }
  candidates.push(join(PUBLIC_DIR, 'index.html'));

  for (const file of candidates) {
    if (!file.startsWith(PUBLIC_DIR)) continue;
    try {
      const data = await readFile(file);
      const type = MIME[extname(file)] || 'application/octet-stream';
      const cache = file.endsWith('index.html') || file.endsWith('sw.js')
        ? 'no-cache'
        : 'public, max-age=300';
      res.writeHead(200, { 'content-type': type, 'cache-control': cache });
      return res.end(data);
    } catch {
      /* fall through to the app shell */
    }
  }
  send(res, 404, { error: 'not found' });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
