/**
 * Planning Workspace — .planning path resolution + active workstream routing.
 *
 * This module owns the planning workspace seam:
 * - planningDir/planningRoot/planningPaths
 * - planning lock semantics
 *
 * Active workstream pointer policy/session identity lives in
 * active-workstream-store.cjs and is consumed here via thin adapters.
 */

const fs = require('fs');
const path = require('path');
const { platformEnsureDir } = require('./shell-command-projection.cjs');
const {
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  getActiveWorkstream: getStoredActiveWorkstream,
  setActiveWorkstream: setStoredActiveWorkstream,
  clearActiveWorkstream: clearStoredActiveWorkstream,
} = require('./active-workstream-store.cjs');

// Track .planning/.lock files held by this process so they can be removed on exit.
const _heldPlanningLocks = new Set();
process.on('exit', () => {
  for (const lockPath of _heldPlanningLocks) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
});

// Transient errno codes that indicate a temporary filesystem condition under
// concurrent O_EXCL races — Docker overlay-fs (ENOENT/EINVAL/EIO), NFS
// (ESTALE), and OS-level interrupt/retry signals (EAGAIN/EINTR).  These are
// recoverable; withPlanningLock retries instead of propagating them.
// Truly fatal codes (EMFILE, ENOSPC, EROFS, EACCES) are NOT in this set and
// will still throw immediately.
const PLANNING_LOCK_RETRY_ERRNOS = new Set([
  'EPERM',   // Windows / macOS AV scanner holds the file open during delete
  'EBUSY',   // Windows: file in use by another process
  'EAGAIN',  // POSIX: resource temporarily unavailable
  'EINTR',   // POSIX: syscall interrupted by signal
  'EINVAL',  // Docker overlay-fs: transient during concurrent O_EXCL creation
  'EIO',     // Docker overlay-fs / NFS: transient I/O error
  'ENOENT',  // Docker overlay-fs: parent dir transiently missing during race
  'ESTALE',  // NFS: stale file handle (self-resolves on retry)
]);

function planningDir(cwd, ws, project) {
  if (project === undefined) project = process.env.GSD_PROJECT || null;
  if (ws === undefined) ws = process.env.GSD_WORKSTREAM || null;

  // Reject path separators and traversal components in project/workstream names
  const BAD_SEGMENT = /[/\\]|\.\./;
  if (project && BAD_SEGMENT.test(project)) {
    throw new Error(`GSD_PROJECT contains invalid path characters: ${project}`);
  }
  if (ws && BAD_SEGMENT.test(ws)) {
    throw new Error(`GSD_WORKSTREAM contains invalid path characters: ${ws}`);
  }

  let base = path.join(cwd, '.planning');
  if (project) base = path.join(base, project);
  if (ws) base = path.join(base, 'workstreams', ws);
  return base;
}

function planningRoot(cwd) {
  return path.join(cwd, '.planning');
}

function planningPaths(cwd, ws) {
  const base = planningDir(cwd, ws);
  return {
    planning: base,
    state: path.join(base, 'STATE.md'),
    roadmap: path.join(base, 'ROADMAP.md'),
    project: path.join(base, 'PROJECT.md'),
    config: path.join(base, 'config.json'),
    phases: path.join(base, 'phases'),
    requirements: path.join(base, 'REQUIREMENTS.md'),
  };
}

function withPlanningLock(cwd, fn) {
  const lockPath = path.join(planningDir(cwd), '.lock');
  const lockTimeout = 10000; // 10 seconds
  const start = Date.now();

  // Ensure .planning/ exists
  try { platformEnsureDir(planningDir(cwd)); } catch { /* ok */ }

  function runWithHeldLock() {
    // Atomic create — fails if file exists
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      cwd,
      acquired: new Date().toISOString(),
    }), { flag: 'wx' });

    _heldPlanningLocks.add(lockPath);

    // Lock acquired — run the function
    try {
      return fn();
    } finally {
      _heldPlanningLocks.delete(lockPath);
      try { fs.unlinkSync(lockPath); } catch { /* already released */ }
    }
  }

  while (Date.now() - start < lockTimeout) {
    try {
      return runWithHeldLock();
    } catch (err) {
      // Transient filesystem errors (Docker overlay-fs, NFS, OS signals, AV scanners)
      // are recoverable — wait and retry rather than propagating.
      // See PLANNING_LOCK_RETRY_ERRNOS for the full list and rationale.
      if (PLANNING_LOCK_RETRY_ERRNOS.has(err.code)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      if (err.code === 'EEXIST') {
        // Lock exists — check if stale (>30s old)
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30000) {
            fs.unlinkSync(lockPath);
            continue; // retry
          }
        } catch { continue; }

        // Wait and retry (cross-platform, no shell dependency)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      throw err;
    }
  }

  // Timeout — stale-lock recovery, then re-acquire atomically before entering critical section.
  try { fs.unlinkSync(lockPath); } catch { /* ok */ }
  return runWithHeldLock();
}

function createPlanningWorkspace(cwd, opts = {}) {
  return {
    paths: {
      dir(ws, project) {
        return planningDir(cwd, ws, project);
      },
      root() {
        return planningRoot(cwd);
      },
      all(ws) {
        return planningPaths(cwd, ws);
      },
    },
    activeWorkstream: {
      get() {
        return getStoredActiveWorkstream(cwd, opts);
      },
      set(name) {
        setStoredActiveWorkstream(cwd, name, opts);
      },
      clear() {
        clearStoredActiveWorkstream(cwd, opts);
      },
    },
  };
}

function getActiveWorkstream(cwd) {
  return getStoredActiveWorkstream(cwd);
}

function setActiveWorkstream(cwd, name) {
  setStoredActiveWorkstream(cwd, name);
}

/**
 * Locate the CONTEXT.md file in a phase directory, handling both the bare
 * form (`CONTEXT.md`) and the padded-prefix convention (`NN-CONTEXT.md`,
 * `NN.N-CONTEXT.md`, etc.) used by gsd-discuss-phase output.
 *
 * Returns the filename (not the full path) of the first match, or null if
 * no CONTEXT.md exists in the directory.
 *
 * Canonical dual-form predicate extracted here to eliminate the 5-site
 * duplication that previously existed across init.cjs, roadmap.cjs,
 * core.cjs, gap-checker.cjs (#3739).
 *
 * @param {string|string[]} absDirOrFiles - Absolute path to the phase directory,
 *   OR an already-read files array (avoids a redundant readdirSync at call sites
 *   that already hold a directory listing).
 * @returns {string|null}
 */
function findContextMdIn(absDirOrFiles) {
  try {
    const files = Array.isArray(absDirOrFiles)
      ? absDirOrFiles
      : fs.readdirSync(absDirOrFiles);
    if (files.includes('CONTEXT.md')) return 'CONTEXT.md';
    return files.find(f => f.endsWith('-CONTEXT.md')) ?? null;
  } catch {
    return null;
  }
}

module.exports = {
  createPlanningWorkspace,
  createSharedPointerAdapter,
  createSessionScopedPointerAdapter,
  createMemoryPointerAdapter,
  planningDir,
  planningRoot,
  planningPaths,
  withPlanningLock,
  getActiveWorkstream,
  setActiveWorkstream,
  findContextMdIn,
};
