import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateInfo } from '../src/update.js';

// Everything runs against throwaway on-disk repos — a bare repo standing in for
// the remote and clones of it — so there is no network and no dependency on the
// real checkout. updateInfo() takes an explicit cwd for exactly this reason.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function commit(dir, name, msg) {
  writeFileSync(join(dir, name), msg);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', msg);
}

// Pull the newest remote refs before asking, so the assertion never depends on
// updateInfo()'s internal fetch-throttle having elapsed.
async function info(dir) {
  git(dir, 'fetch', '--quiet');
  return updateInfo(dir);
}

let tmp, remote, work;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wt-update-'));
  remote = join(tmp, 'remote.git');
  work = join(tmp, 'work');

  git(tmp, 'init', '--bare', remote);
  git(tmp, 'clone', remote, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'checkout', '-b', 'main');
  commit(work, 'a.txt', 'first');
  git(work, 'push', '-u', 'origin', 'main');
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe('updateInfo', () => {
  test('reports disabled for a non-git directory', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'wt-plain-'));
    const res = await updateInfo(plain);
    assert.equal(res.enabled, false);
    assert.equal(res.reason, 'not a git checkout');
    rmSync(plain, { recursive: true, force: true });
  });

  test('reports up to date when the clone matches the remote', async () => {
    const res = await info(work);
    assert.equal(res.enabled, true);
    assert.equal(res.behind, 0);
    assert.equal(res.available, false);
    assert.match(res.current, /^[0-9a-f]{7,}$/);
  });

  test('flags an available update when the remote is ahead', async () => {
    // A second clone pushes a new commit the first one hasn't seen yet.
    const other = join(tmp, 'other');
    git(tmp, 'clone', remote, other);
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'Test');
    commit(other, 'b.txt', 'Add a shiny feature');
    git(other, 'push', 'origin', 'main');

    const res = await info(work);
    assert.equal(res.enabled, true);
    assert.equal(res.behind, 1);
    assert.equal(res.available, true);
    assert.equal(res.latest, 'Add a shiny feature');
  });

  test('a dirty working tree suppresses the update', async () => {
    // The remote is still one commit ahead from the previous test; a local edit
    // must block the offered update (ff-only pull would fail).
    writeFileSync(join(work, 'a.txt'), 'local edit');
    const res = await info(work);
    assert.equal(res.dirty, true);
    assert.equal(res.available, false);
    // Restore so the shared fixture stays clean.
    git(work, 'checkout', '--', 'a.txt');
  });
});
