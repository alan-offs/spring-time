// Self-update over git. The tool is installed as a git checkout, so "a new
// version" is just new commits on the tracking branch. We shell out to the `git`
// binary (zero runtime deps) rather than reimplement any of it.
//
// updateInfo() is what the dashboard polls; applyUpdate() spawns the detached
// `wt update` that actually pulls + restarts (see bin/wt.js cmdUpdate). Nothing
// here ever throws to the caller — a machine without git, without a remote, or
// offline simply reports `enabled: false` with a reason.
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// `git fetch` hits the network; the dashboard polls updateInfo() often, so we
// fetch at most once per FETCH_TTL and answer from local refs in between.
const FETCH_TTL = 15 * 60 * 1000;
let lastFetch = 0;

function git(args, cwd, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim())
    );
  });
}

/**
 * `cwd` is overridable so tests can point at a throwaway repo; production always
 * passes the default (the installed checkout).
 * @returns {Promise<{enabled:boolean, current?:string, behind?:number,
 *   available?:boolean, dirty?:boolean, latest?:string, reason?:string}>}
 */
export async function updateInfo(cwd = ROOT) {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], cwd);
  } catch {
    return { enabled: false, reason: 'not a git checkout' };
  }

  let current, dirty;
  try {
    current = await git(['rev-parse', '--short', 'HEAD'], cwd);
    dirty = (await git(['status', '--porcelain'], cwd)) !== '';
  } catch {
    return { enabled: false, reason: 'git unavailable' };
  }

  // No configured upstream → nothing to update against.
  try {
    await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  } catch {
    return { enabled: false, current, dirty, reason: 'no upstream branch' };
  }

  if (Date.now() - lastFetch > FETCH_TTL) {
    try {
      await git(['fetch', '--quiet'], cwd);
      lastFetch = Date.now();
    } catch {
      // Offline or auth failure — fall through and report against cached refs.
      return { enabled: true, current, dirty, behind: 0, available: false, reason: 'fetch failed' };
    }
  }

  try {
    const behind = Number(await git(['rev-list', '--count', 'HEAD..@{u}'], cwd));
    const latest = behind > 0 ? await git(['log', '-1', '--format=%s', '@{u}'], cwd) : '';
    return { enabled: true, current, dirty, behind, latest, available: behind > 0 && !dirty };
  } catch {
    return { enabled: true, current, dirty, behind: 0, available: false, reason: 'compare failed' };
  }
}

/**
 * Fire-and-forget the restarting updater. It has to outlive the server process
 * it kills, so it is fully detached and unref'd.
 */
export function applyUpdate() {
  const child = spawn(process.execPath, [join(ROOT, 'bin/wt.js'), 'update'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
