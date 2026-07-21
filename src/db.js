import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db;

export function open(file) {
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate();
  return db;
}

export function handle() {
  if (!db) throw new Error('database not opened');
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#6366f1',
      archived   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      description TEXT NOT NULL DEFAULT '',
      tags        TEXT NOT NULL DEFAULT '',
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      status      TEXT NOT NULL DEFAULT '',
      percent     INTEGER,
      eta         TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Google sign-in is identity only: nothing in projects/entries references a
    -- user, so these two tables can be dropped without touching tracked time.
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub    TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL DEFAULT '',
      name          TEXT NOT NULL DEFAULT '',
      picture       TEXT NOT NULL DEFAULT '',
      -- OAuth tokens for calling Google APIs (Sheets) on the user's behalf.
      -- Null until the user re-consents to the expanded scope.
      access_token  TEXT,
      refresh_token TEXT,
      token_expiry  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_started ON entries(started_at);
    CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);
    -- At most one timer may run at a time, across all projects.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_single_running
      ON entries((1)) WHERE ended_at IS NULL;
  `);

  // Additive column adds for databases created before these fields existed.
  // migrate() only runs CREATE TABLE IF NOT EXISTS, so pre-existing tables miss
  // the columns above; ALTER them in, guarded by the current column set.
  const have = new Set(db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name));
  if (!have.has('status')) db.exec("ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT ''");
  if (!have.has('percent')) db.exec('ALTER TABLE entries ADD COLUMN percent INTEGER');
  if (!have.has('eta')) db.exec('ALTER TABLE entries ADD COLUMN eta TEXT');

  // Google API tokens on users, added when Sheets write-back landed.
  const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!userCols.has('access_token')) db.exec('ALTER TABLE users ADD COLUMN access_token TEXT');
  if (!userCols.has('refresh_token')) db.exec('ALTER TABLE users ADD COLUMN refresh_token TEXT');
  if (!userCols.has('token_expiry')) db.exec('ALTER TABLE users ADD COLUMN token_expiry TEXT');
}

/** Turn any free text into a URL-safe slug. */
export function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Categorical slots in fixed order — this ordering is the CVD-safety mechanism,
// not cosmetics. Light-mode hexes; the client maps each to its dark-mode step.
// Validated: worst adjacent CVD ΔE 9.1 light / 8.4 dark.
const PALETTE = [
  '#2a78d6', '#008300', '#e87ba4', '#eda100',
  '#1baf7a', '#eb6834', '#4a3aa7', '#e34948',
];

/**
 * Look up a project by slug, creating it on first sight. This is what makes a
 * bare URL like /p/acme-api a working tracker with no setup step.
 */
export function ensureProject(slug, name) {
  const clean = slugify(slug);
  if (!clean) throw new HttpError(400, 'invalid project slug');

  const found = handle().prepare('SELECT * FROM projects WHERE slug = ?').get(clean);
  if (found) return found;

  const count = handle().prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  handle()
    .prepare('INSERT INTO projects (slug, name, color) VALUES (?, ?, ?)')
    .run(clean, name || titleize(clean), PALETTE[count % PALETTE.length]);

  return handle().prepare('SELECT * FROM projects WHERE slug = ?').get(clean);
}

function titleize(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
